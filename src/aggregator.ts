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

import {
	ArrayTableValue,
	DictionaryTableValue,
	type EntryUpdate,
	FrequencyCounterTableValue,
	SignedInt32TableValue,
	type TableDefinition,
	type TableKey,
	type TableValue,
	UnsignedInt32TableValue,
	UnsignedInt64TableValue,
} from "./types";
import {
	DataType,
	DecodedType,
	type FrequencyCounter,
	getArrayElementType,
	getDecodedType,
} from "./wire-types";

/**
 * Merges two values of the same data type that originate from different peers.
 * `existing` is the value already held by the store (or `undefined` when the
 * key was previously unseen) and `incoming` is the newly received value.
 */
export type MergeStrategy = (
	dataType: DataType,
	existing: TableValue<unknown> | undefined,
	incoming: TableValue<unknown>,
) => TableValue<unknown>;

function isCounter(dataType: DataType): boolean {
	switch (dataType) {
		case DataType.CONN_CNT:
		case DataType.CONN_CUR:
		case DataType.SESS_CNT:
		case DataType.HTTP_REQ_CNT:
		case DataType.HTTP_ERR_CNT:
		case DataType.HTTP_FAIL_CNT:
		case DataType.BYTES_IN_CNT:
		case DataType.BYTES_OUT_CNT:
		case DataType.GPC0:
		case DataType.GPC1:
		case DataType.GLITCH_CNT:
			return true;

		default:
			return false;
	}
}

function mergeFrequencyCounters(
	existing: FrequencyCounter,
	incoming: FrequencyCounter,
): FrequencyCounter {
	// Counters share a tick: the totals can be added directly. Otherwise the
	// most recent sample wins, since rolling an older window forward would
	// require the period which is not available here.
	if (existing.currentTick === incoming.currentTick) {
		return {
			currentTick: incoming.currentTick,
			currentCounter: existing.currentCounter + incoming.currentCounter,
			previousCounter: existing.previousCounter + incoming.previousCounter,
		};
	}

	return incoming.currentTick > existing.currentTick ? incoming : existing;
}

/**
 * Default merge: sum counters and gauges, combine frequency counters and
 * arrays element-wise, and take the most recent value for everything else
 * (server ids, tags, dictionary entries).
 */
export const defaultMergeStrategy: MergeStrategy = (
	dataType,
	existing,
	incoming,
) => {
	if (existing === undefined) {
		return incoming;
	}

	const decodedType = getDecodedType(dataType);

	switch (decodedType) {
		case DecodedType.UINT:
		case DecodedType.ULONGLONG: {
			if (!isCounter(dataType)) {
				return incoming;
			}
			if (decodedType === DecodedType.UINT) {
				const sum = (existing.value as number) + (incoming.value as number);
				return new UnsignedInt32TableValue(sum);
			}

			const sum = (existing.value as bigint) + (incoming.value as bigint);
			return new UnsignedInt64TableValue(sum);
		}

		case DecodedType.FREQUENCY_COUNTER:
			return new FrequencyCounterTableValue(
				mergeFrequencyCounters(
					(existing as FrequencyCounterTableValue).value,
					(incoming as FrequencyCounterTableValue).value,
				),
			);

		case DecodedType.ARRAY: {
			const elementType = getArrayElementType(dataType);
			const existingItems = (existing as ArrayTableValue<unknown>).value;
			const incomingItems = (incoming as ArrayTableValue<unknown>).value;
			const length = Math.max(existingItems.length, incomingItems.length);
			const merged: unknown[] = [];
			for (let i = 0; i < length; i++) {
				const a = existingItems[i];
				const b = incomingItems[i];
				if (a === undefined) {
					merged.push(b);
				} else if (b === undefined) {
					merged.push(a);
				} else if (elementType === DecodedType.FREQUENCY_COUNTER) {
					merged.push(
						mergeFrequencyCounters(
							a as FrequencyCounter,
							b as FrequencyCounter,
						),
					);
				} else {
					merged.push((a as number) + (b as number));
				}
			}
			return new ArrayTableValue(merged);
		}

		case DecodedType.SINT:
			return new SignedInt32TableValue(incoming.value as number);

		case DecodedType.DICTIONARY: {
			const value = (incoming as DictionaryTableValue).value;
			return value === null ? existing : incoming;
		}

		default:
			return incoming;
	}
};

/**
 * A single aggregated table entry keyed by the stick table key.
 */
export interface StoredEntry {
	key: TableKey<unknown>;
	expiry: number | null;
	values: Map<DataType, TableValue<unknown>>;
}

function keyToString(key: TableKey<unknown>): string {
	return `${key.type}:${String(key.key)}`;
}

function emptyFrequencyCounter(): FrequencyCounter {
	return { currentTick: 0, currentCounter: 0, previousCounter: 0 };
}

/**
 * Builds the neutral value for a data type. Used to complete stored entries so
 * that every entry carries a value for each data type in its table definition
 * (matching HAProxy, where every configured type is always present) and can be
 * re-serialized — e.g. when teaching the entry back to another peer.
 */
function defaultValue(
	dataType: DataType,
	definition: TableDefinition,
): TableValue<unknown> {
	const decodedType = getDecodedType(dataType);

	switch (decodedType) {
		case DecodedType.SINT:
			return new SignedInt32TableValue(0);

		case DecodedType.UINT:
			return new UnsignedInt32TableValue(0);

		case DecodedType.ULONGLONG:
			return new UnsignedInt64TableValue(0n);

		case DecodedType.FREQUENCY_COUNTER:
			return new FrequencyCounterTableValue(emptyFrequencyCounter());

		case DecodedType.DICTIONARY:
			return new DictionaryTableValue(null);

		case DecodedType.ARRAY: {
			const count = definition.dataTypeParameters.get(dataType)?.count ?? 0;
			const elementType = getArrayElementType(dataType);
			const items: unknown[] = [];
			for (let i = 0; i < count; i++) {
				items.push(
					elementType === DecodedType.FREQUENCY_COUNTER
						? emptyFrequencyCounter()
						: 0,
				);
			}
			return new ArrayTableValue(items);
		}

		default:
			throw new Error(`no default value for data type '${DataType[dataType]}'`);
	}
}

/**
 * In-memory store that aggregates stick table entries received from one or
 * more peers. Definitions are tracked by table name so that entries from
 * different source peers (which use independent `senderTableId`s) collapse
 * into a single logical table.
 */
export class StickTableStore {
	private readonly definitions = new Map<string, TableDefinition>();
	private readonly tables = new Map<string, Map<string, StoredEntry>>();

	constructor(private readonly merge: MergeStrategy = defaultMergeStrategy) {}

	/**
	 * Records (or refreshes) a table definition.
	 */
	applyDefinition(definition: TableDefinition): void {
		this.definitions.set(definition.name, definition);
		if (!this.tables.has(definition.name)) {
			this.tables.set(definition.name, new Map());
		}
	}

	/**
	 * Merges an entry update into the aggregated state for its table.
	 */
	applyUpdate(definition: TableDefinition, update: EntryUpdate): void {
		this.applyDefinition(definition);

		const table = this.tables.get(definition.name);
		if (table === undefined) {
			throw new Error(`unknown table '${definition.name}'`);
		}

		const keyString = keyToString(update.key);
		const existing = table.get(keyString);

		const values = new Map<DataType, TableValue<unknown>>(
			existing?.values ?? [],
		);
		for (const [dataType, value] of update.values) {
			values.set(
				dataType,
				this.merge(dataType, existing?.values.get(dataType), value),
			);
		}

		// Keep every entry complete so it can be re-serialized (e.g. taught back to
		// a peer): fill any data type from the definition that has never been seen
		// with its neutral default. Received values still flow through merge above.
		for (const { dataType } of definition.dataTypeDefinitions) {
			if (!values.has(dataType)) {
				values.set(dataType, defaultValue(dataType, definition));
			}
		}

		table.set(keyString, {
			key: update.key,
			expiry: update.expiry,
			values,
		});
	}

	/**
	 * Returns the known definition for a table, if any.
	 */
	getDefinition(tableName: string): TableDefinition | undefined {
		return this.definitions.get(tableName);
	}

	/**
	 * Returns the known table names.
	 */
	getTableNames(): string[] {
		return [...this.tables.keys()];
	}

	/**
	 * Returns the aggregated entries for a table.
	 */
	getEntries(tableName: string): StoredEntry[] {
		const table = this.tables.get(tableName);
		return table ? [...table.values()] : [];
	}

	/**
	 * Removes all entries for a table (definitions are retained).
	 */
	clearEntries(tableName: string): void {
		this.tables.get(tableName)?.clear();
	}
}
