/*!
 * Copyright (C) 2020 WoltLab GmbH
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: LGPL-3.0-or-later
 */

import { inet_pton } from "inet_xtoy";
import type {
	ArrayTableValue,
	DictionaryTableValue,
	EntryUpdate,
	FrequencyCounterTableValue,
	TableDefinition,
	TableKey,
	TableValue,
	UnsignedInt64TableValue,
} from "./types";
import * as VarInt from "./varint";
import {
	type ControlMessageClass,
	DataType,
	DecodedType,
	type FrequencyCounter,
	getArrayElementType,
	getDecodedType,
	isArrayDataType,
	isFrequencyCounterDataType,
	MessageClass,
	type StatusMessageCode,
	TableKeyType,
	UpdateMessageType,
} from "./wire-types";

/**
 * Tracks dictionary cache entries (`STD_T_DICT`) for the sending side of a
 * connection. The first time a string is sent its full value is transmitted
 * together with a freshly assigned cache id. Subsequent transmissions only
 * send the id, which the remote peer resolves against its own cache.
 *
 * Ids are 1-based to match HAProxy, which stores received entries at `id - 1`.
 */
export class DictionaryEncoder {
	private readonly ids = new Map<string, number>();
	private nextId = 1;

	/**
	 * Encodes a single dictionary value as it appears inside an entry update.
	 */
	encode(value: string | null): Buffer {
		if (value === null) {
			return VarInt.encode(0);
		}

		const existing = this.ids.get(value);
		if (existing !== undefined) {
			const entry = VarInt.encode(existing);
			return Buffer.concat([VarInt.encode(entry.length), entry]);
		}

		const id = this.nextId++;
		this.ids.set(value, id);

		const stringBuffer = Buffer.from(value);
		const entry = Buffer.concat([
			VarInt.encode(id),
			VarInt.encode(stringBuffer.length),
			stringBuffer,
		]);

		return Buffer.concat([VarInt.encode(entry.length), entry]);
	}
}

function encodeFrequencyCounter(counter: FrequencyCounter): Buffer {
	return Buffer.concat([
		VarInt.encode(counter.currentTick),
		VarInt.encode(counter.currentCounter),
		VarInt.encode(counter.previousCounter),
	]);
}

function encodeKey(key: TableKey<unknown>, keyLen: number): Buffer {
	switch (key.type) {
		case TableKeyType.BINARY:
			return Buffer.from(key.key as string, "hex");

		case TableKeyType.STRING: {
			const stringBuffer = Buffer.from(key.key as string);
			return Buffer.concat([VarInt.encode(stringBuffer.length), stringBuffer]);
		}

		case TableKeyType.SINT: {
			const buffer = Buffer.alloc(4);
			buffer.writeInt32BE(key.key as number, 0);
			return buffer;
		}

		case TableKeyType.IPv4:
		case TableKeyType.IPv6: {
			const packed = inet_pton(key.key as string);
			if (packed === null) {
				throw new Error(`unable to encode key '${key.key as string}'`);
			}
			if (packed.length !== keyLen) {
				throw new Error(
					`encoded key length ${packed.length} does not match table keyLen ${keyLen}`,
				);
			}
			return packed;
		}

		default:
			throw new Error(`unable to encode key type '${key.type as string}'`);
	}
}

function encodeValue(
	dataType: DataType,
	value: TableValue<unknown>,
	dictionary: DictionaryEncoder,
): Buffer {
	const decodedType = getDecodedType(dataType);

	switch (decodedType) {
		case DecodedType.SINT:
		case DecodedType.UINT:
			return VarInt.encode(value.value as number);

		case DecodedType.ULONGLONG:
			return VarInt.encode((value as UnsignedInt64TableValue).value);

		case DecodedType.FREQUENCY_COUNTER:
			return encodeFrequencyCounter(
				(value as FrequencyCounterTableValue).value,
			);

		case DecodedType.DICTIONARY:
			return dictionary.encode((value as DictionaryTableValue).value);

		case DecodedType.ARRAY: {
			const elementType = getArrayElementType(dataType);
			const items = (value as ArrayTableValue<unknown>).value;
			const buffers: Buffer[] = [];
			for (const item of items) {
				switch (elementType) {
					case DecodedType.UINT:
						buffers.push(VarInt.encode(item as number));
						break;

					case DecodedType.FREQUENCY_COUNTER:
						buffers.push(encodeFrequencyCounter(item as FrequencyCounter));
						break;

					default:
						throw new Error(
							`unable to encode array element type '${DecodedType[elementType]}'`,
						);
				}
			}
			return Buffer.concat(buffers);
		}

		default:
			throw new Error(`unable to encode data type '${DataType[dataType]}'`);
	}
}

function frame(messageClass: MessageClass, type: number, body: Buffer): Buffer {
	return Buffer.concat([
		Buffer.from([messageClass, type]),
		VarInt.encode(body.length),
		body,
	]);
}

/**
 * Encodes a stick table definition message.
 */
export function encodeTableDefinition(definition: TableDefinition): Buffer {
	const dataTypes = [...definition.dataTypes].sort((a, b) => a - b);

	let bitfield = 0;
	for (const dataType of dataTypes) {
		bitfield |= 1 << dataType;
	}

	const parts: Buffer[] = [VarInt.encode(definition.senderTableId)];

	const nameBuffer = Buffer.from(definition.name, "binary");
	parts.push(VarInt.encode(nameBuffer.length), nameBuffer);

	parts.push(
		VarInt.encode(definition.keyType),
		VarInt.encode(definition.keyLen),
		VarInt.encode(bitfield),
		VarInt.encode(definition.expiry),
	);

	for (const dataType of dataTypes) {
		const parameters = definition.dataTypeParameters.get(dataType);

		if (isArrayDataType(dataType)) {
			if (parameters?.count === undefined) {
				throw new Error(`missing array count for '${DataType[dataType]}'`);
			}
			parts.push(VarInt.encode(parameters.count));

			if (dataType === DataType.GPC_RATE_ARRAY) {
				if (parameters.period === undefined) {
					throw new Error(`missing array period for '${DataType[dataType]}'`);
				}
				parts.push(VarInt.encode(parameters.period));
			}
			continue;
		}

		if (isFrequencyCounterDataType(dataType)) {
			if (parameters?.period === undefined) {
				throw new Error(`missing period for '${DataType[dataType]}'`);
			}
			parts.push(VarInt.encode(parameters.period));
		}
	}

	return frame(
		MessageClass.UPDATE,
		UpdateMessageType.STICK_TABLE_DEFINITION,
		Buffer.concat(parts),
	);
}

/**
 * Encodes a stick table entry update message.
 */
export function encodeEntryUpdate(
	definition: TableDefinition,
	update: EntryUpdate,
	dictionary: DictionaryEncoder,
	options: { incremental?: boolean } = {},
): Buffer {
	const incremental = options.incremental ?? false;
	const timed = update.expiry !== null;

	let type: UpdateMessageType;
	if (incremental) {
		type = timed
			? UpdateMessageType.INCREMENTAL_ENTRY_UPDATE_TIMED
			: UpdateMessageType.INCREMENTAL_ENTRY_UPDATE;
	} else {
		type = timed
			? UpdateMessageType.ENTRY_UPDATE_TIMED
			: UpdateMessageType.ENTRY_UPDATE;
	}

	const parts: Buffer[] = [];

	if (!incremental) {
		const updateId = Buffer.alloc(4);
		updateId.writeUInt32BE(update.updateId, 0);
		parts.push(updateId);
	}

	if (timed) {
		const expiry = Buffer.alloc(4);
		expiry.writeUInt32BE(update.expiry ?? 0, 0);
		parts.push(expiry);
	}

	parts.push(encodeKey(update.key, definition.keyLen));

	// Values must be written in ascending data type order to match the sorted
	// bitfield emitted by encodeTableDefinition and the order the parser reads.
	const dataTypes = definition.dataTypeDefinitions
		.map((d) => d.dataType)
		.sort((a, b) => a - b);
	for (const dataType of dataTypes) {
		const value = update.values.get(dataType);
		if (value === undefined) {
			throw new Error(`missing value for data type '${DataType[dataType]}'`);
		}
		parts.push(encodeValue(dataType, value, dictionary));
	}

	return frame(MessageClass.UPDATE, type, Buffer.concat(parts));
}

/**
 * Encodes an acknowledgement for the given table/update id pair.
 */
export function encodeAck(tableId: number, updateId: number): Buffer {
	const encodedTableId = VarInt.encode(tableId);
	const encodedUpdateId = Buffer.alloc(4);
	encodedUpdateId.writeUInt32BE(updateId, 0);

	return Buffer.concat([
		Buffer.from([MessageClass.UPDATE, UpdateMessageType.ACK]),
		VarInt.encode(encodedTableId.length + 4),
		encodedTableId,
		encodedUpdateId,
	]);
}

/**
 * Encodes a stick table switch (id pointer) message.
 */
export function encodeStickTableSwitch(tableId: number): Buffer {
	return frame(
		MessageClass.UPDATE,
		UpdateMessageType.STICK_TABLE_SWITCH,
		VarInt.encode(tableId),
	);
}

/**
 * Encodes a bare control message (heartbeat or synchronization signalling).
 */
export function encodeControlMessage(type: ControlMessageClass): Buffer {
	return Buffer.from([MessageClass.CONTROL, type]);
}

/**
 * Encodes the plaintext handshake "hello" message sent when opening a
 * connection. `protocolVersion` is the version announced after `HAProxyS`.
 */
export function encodeHello(options: {
	protocolVersion: string;
	remotePeerName: string;
	localPeerName: string;
	processId?: number;
	relativePid?: number;
}): Buffer {
	const processId = options.processId ?? 0;
	const relativePid = options.relativePid ?? 0;

	return Buffer.from(
		`HAProxyS ${options.protocolVersion}\n` +
			`${options.remotePeerName}\n` +
			`${options.localPeerName} ${processId} ${relativePid}\n`,
	);
}

/**
 * Encodes the plaintext status reply sent in response to a handshake.
 */
export function encodeStatus(code: StatusMessageCode): Buffer {
	return Buffer.from(`${code}\n`);
}
