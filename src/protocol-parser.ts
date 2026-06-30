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
import d from 'debug';
import { inet_ntop } from 'inet_xtoy';
import { Transform, TransformCallback, TransformOptions } from 'stream';
import * as messages from './messages';
import {
  ArrayTableValue,
  BinaryTableKey,
  DictionaryTableValue,
  FrequencyCounterTableValue,
  IPv4TableKey,
  IPv6TableKey,
  SignedInt32TableKey,
  SignedInt32TableValue,
  StringTableKey,
  TableDefinition,
  TableKey,
  TableValue,
  UnsignedInt32TableValue,
  UnsignedInt64TableValue,
} from './types';
import * as VarInt from './varint';
import {
  ControlMessageClass,
  DataType,
  DecodedType,
  getArrayElementType,
  getDecodedType,
  isArrayDataType,
  isFrequencyCounterDataType,
  MessageClass,
  TableKeyType,
  UpdateMessageType,
} from './wire-types';

const debug = d('haproxy-peers:protocol-parser');

/**
 * Helper class for safe buffer handling.
 */
class Pointer {
  private position = 0;

  constructor(private size: number) {}

  /**
   * Moves the pointer forward by the given amount.
   * Throws the given error message (or a generic message) if size
   * is exceeded after the consumption.
   */
  consume(amount: number, error?: string): void {
    this.position += amount;
    if (this.position > this.size) {
      throw new Error(error || 'Pointer exceeded');
    }
  }

  /**
   * Asserts that the pointer can be moved by the given amount.
   * Throws the given error message (or a generic message) if size
   * would be exceeded when calling `consume(amount)`.
   */
  assert(amount: number, error?: string): void {
    if (this.position + amount > this.size) {
      throw new Error(error || 'Pointer exceeded');
    }
  }

  /**
   * Returns whether the current position reached the maximum size.
   */
  isEmpty(): boolean {
    return this.position >= this.size;
  }

  /**
   * Returns a slice of the given buffer starting at the current position of the Pointer.
   * If `end` is given the slice will contain exactly `end` bytes. An error is thrown if
   * the Pointer does not contain `end` bytes.
   */
  sliceBuffer(buffer: Buffer, end?: number, error?: string): Buffer {
    if (end !== undefined) {
      this.assert(end, error);
      return buffer.slice(this.position, this.position + end);
    }
    return buffer.slice(this.position);
  }

  /**
   * Returns the current position of the Pointer.
   */
  get(): number {
    return this.position;
  }
}

export class PeerParser extends Transform {
  private buffer: Buffer;
  private dictionaryCache: Map<number, string>;
  private lastTableDefinition?: TableDefinition;
  private lastUpdateId: number;

  constructor(options: TransformOptions = {}) {
    options.readableObjectMode = true;
    super(options);
    this.buffer = Buffer.alloc(0);
    this.dictionaryCache = new Map<number, string>();
    this.lastUpdateId = 0;
  }

  /**
   * Attempt to parse the contents in the given Buffer. Returns the
   * number of consumed bytes or `null` if no complete message could be parsed.
   *
   * @param buffer
   */
  private parseMessage(buffer: Buffer): number | null {
    if (buffer.length < 1) {
      return null;
    }

    const map = new Map<MessageClass, (buffer: Buffer) => number | null>([
      [MessageClass.CONTROL, (buffer) => this.parseControlMessage(buffer)],
      [MessageClass.UPDATE, (buffer) => this.parseUpdateMessage(buffer)],
    ]);

    const parseMethod = map.get(buffer[0]);
    if (!parseMethod) {
      throw new Error(`unhandled MessageClass '${buffer[0]}'.`);
    }

    const consumed = parseMethod(buffer.slice(1));
    if (consumed !== null) {
      return 1 + consumed;
    }

    return null;
  }

  private parseControlMessage(buffer: Buffer): number | null {
    if (buffer.length < 1) {
      return null;
    }

    const map = new Map<ControlMessageClass, new () => messages.Message>([
      [ControlMessageClass.HEARTBEAT, messages.Heartbeat],
      [
        ControlMessageClass.SYNCHRONIZATION_REQUEST,
        messages.SynchronizationRequest,
      ],
      [
        ControlMessageClass.SYNCHRONIZATION_FINISHED,
        messages.SynchronizationFull,
      ],
      [
        ControlMessageClass.SYNCHRONIZATION_PARTIAL,
        messages.SynchronizationPartial,
      ],
      [
        ControlMessageClass.SYNCHRONIZATION_CONFIRMED,
        messages.SynchronizationConfirmed,
      ],
    ]);

    const messageClass = map.get(buffer[0]);
    if (!messageClass) {
      throw new Error(`unhandled ControlMessageClass '${buffer[0]}'`);
    }

    this.push(new messageClass());

    return 1;
  }

  private parseUpdateMessage(buffer: Buffer): number | null {
    if (buffer.length < 1) {
      return null;
    }

    switch (buffer[0] as UpdateMessageType) {
      case UpdateMessageType.STICK_TABLE_DEFINITION: {
        const consumed = this.parseTableDefinition(buffer.slice(1));
        if (consumed !== null) {
          return 1 + consumed;
        }
        return null;
      }

      case UpdateMessageType.ENTRY_UPDATE:
      case UpdateMessageType.ENTRY_UPDATE_TIMED:
      case UpdateMessageType.INCREMENTAL_ENTRY_UPDATE:
      case UpdateMessageType.INCREMENTAL_ENTRY_UPDATE_TIMED: {
        if (this.lastTableDefinition === undefined) {
          throw new Error(
            'Unable to handle entry updates without a stick table definition'
          );
        }

        const incremental =
          buffer[0] === UpdateMessageType.INCREMENTAL_ENTRY_UPDATE ||
          buffer[0] === UpdateMessageType.INCREMENTAL_ENTRY_UPDATE_TIMED;
        const timed =
          buffer[0] === UpdateMessageType.ENTRY_UPDATE_TIMED ||
          buffer[0] === UpdateMessageType.INCREMENTAL_ENTRY_UPDATE_TIMED;
        const consumed = this.parseEntryUpdate(buffer.slice(1), {
          incremental,
          timed,
        });

        if (consumed !== null) {
          return 1 + consumed;
        }

        return null;
      }

      default: {
        throw new Error(`unhandled UpdateMessageType '${buffer[0]}'`);
      }
    }
  }

  /**
   * Attempt to parse a stick table definition.
   *
   * Returns the number of bytes consumed or
   * `null` if no complete definition could be found.
   *
   * @param buffer
   */
  private parseTableDefinition(buffer: Buffer): number | null {
    debug('attempting to parse table definition');

    let length: number,
      senderTableId: number,
      nameLength: number,
      keyType: TableKeyType,
      keyLen: number,
      dataTypeBitfield: number,
      expiry: number;

    let consumed;
    [consumed, length] = VarInt.decode(buffer);
    const pointer = new Pointer(consumed + length);
    pointer.consume(consumed);
    length += consumed;
    if (buffer.length < length) {
      return null;
    }

    [consumed, senderTableId] = VarInt.decode(pointer.sliceBuffer(buffer));
    pointer.consume(consumed, 'Incorrect packet length (senderTableId)');

    [consumed, nameLength] = VarInt.decode(pointer.sliceBuffer(buffer));
    pointer.consume(consumed, 'Incorrect packet length (nameLength)');

    const name = pointer
      .sliceBuffer(buffer, nameLength, 'Insufficient data (name)')
      .toString('binary');
    pointer.consume(nameLength, 'Incorrect packet length (name)');

    [consumed, keyType] = VarInt.decode(pointer.sliceBuffer(buffer));
    pointer.consume(consumed, 'Incorrect packet length (keyType)');

    if (!TableKeyType[keyType]) {
      throw new Error(`Incorrect key type '${keyType}'`);
    }

    [consumed, keyLen] = VarInt.decode(pointer.sliceBuffer(buffer));
    pointer.consume(consumed, 'Incorrect packet length (keyLen)');

    [consumed, dataTypeBitfield] = VarInt.decode(pointer.sliceBuffer(buffer));
    pointer.consume(consumed, 'Incorrect packet length (dataType)');

    [consumed, expiry] = VarInt.decode(pointer.sliceBuffer(buffer));
    pointer.consume(consumed, 'Incorrect packet length (expiry)');

    const dataTypes: DataType[] = [];
    for (let i = 0; i < 32; i++) {
      if ((dataTypeBitfield >> i) & 1) {
        dataTypes.push(i as DataType);
      }
    }

    const dataTypeParameters = new Map<
      DataType,
      { count?: number; period?: number }
    >();
    const dataTypeDefinitions: {
      dataType: DataType;
      count?: number;
      period?: number;
    }[] = [];

    for (const dataType of dataTypes) {
      const decodedType = getDecodedType(dataType);

      if (isArrayDataType(dataType)) {
        let count: number;
        [consumed, count] = VarInt.decode(pointer.sliceBuffer(buffer));
        pointer.consume(consumed, 'Incorrect packet length (count)');

        const definition: {
          dataType: DataType;
          count?: number;
          period?: number;
        } = {
          dataType,
          count,
        };

        if (dataType === DataType.GPC_RATE_ARRAY) {
          let period: number;
          [consumed, period] = VarInt.decode(pointer.sliceBuffer(buffer));
          pointer.consume(consumed, 'Incorrect packet length (period)');
          definition.period = period;
        }

        dataTypeDefinitions.push(definition);
        dataTypeParameters.set(dataType, {
          count: definition.count,
          period: definition.period,
        });
        continue;
      }

      if (isFrequencyCounterDataType(dataType)) {
        let period: number;
        [consumed, period] = VarInt.decode(pointer.sliceBuffer(buffer));
        pointer.consume(consumed, 'Incorrect packet length (period)');

        dataTypeDefinitions.push({ dataType, period });
        dataTypeParameters.set(dataType, { period });
        continue;
      }

      if (
        decodedType !== DecodedType.SINT &&
        decodedType !== DecodedType.UINT &&
        decodedType !== DecodedType.ULONGLONG &&
        decodedType !== DecodedType.DICTIONARY
      ) {
        throw new Error(`Unsupported data type '${DataType[dataType]}'`);
      }

      dataTypeDefinitions.push({ dataType });
      dataTypeParameters.set(dataType, {});
    }

    if (!pointer.isEmpty()) {
      throw new Error('Incorrect packet length (total)');
    }

    const definition = {
      senderTableId,
      name,
      keyType,
      keyLen,
      dataTypes,
      dataTypeParameters,
      expiry,
      dataTypeDefinitions,
    };

    this.lastTableDefinition = definition;

    this.push(new messages.TableDefinition(definition));

    return pointer.get();
  }

  /**
   * Attempt to parse an entry update message.
   * Returns a pair of the number of bytes consume and an object containing the table
   * definition used for parsing and the actual entry update or `null` if no complete
   * message could be found.
   *
   * @param buffer
   * @param isTimed
   */
  private parseEntryUpdate(
    buffer: Buffer,
    options: {
      timed: boolean;
      incremental: boolean;
    }
  ): number | null {
    debug('attempting to parse entry update %o', options);

    const tableDefinition = this.lastTableDefinition;
    if (tableDefinition === undefined) {
      throw new Error(
        'unable to parse entry update without a stick table definition'
      );
    }

    let length: number,
      updateId: number,
      expiry: number | null = null,
      key: TableKey<unknown>;

    let consumed: number;
    [consumed, length] = VarInt.decode(buffer);

    const pointer = new Pointer(consumed + length);
    pointer.consume(consumed);

    length += consumed;
    if (buffer.length < length) {
      return null;
    }

    if (options.incremental) {
      updateId = this.lastUpdateId + 1;
    } else {
      pointer.assert(4, 'insufficient data (updateId)');
      updateId = buffer.readUInt32BE(pointer.get());
      pointer.consume(4, 'incorrect packet length (updateId)');
    }

    if (options.timed) {
      pointer.assert(4, 'insufficient data (expiry)');
      expiry = buffer.readUInt32BE(pointer.get());
      pointer.consume(4, 'incorrect packet length (expiry)');
    }

    switch (tableDefinition.keyType) {
      case TableKeyType.BINARY: {
        const keyLen = tableDefinition.keyLen;
        pointer.assert(keyLen, 'insufficient data (key)');
        key = new BinaryTableKey(
          pointer.sliceBuffer(buffer, keyLen).toString('hex')
        );
        pointer.consume(keyLen, 'incorrect packet length (key)');
        break;
      }

      case TableKeyType.STRING: {
        let keyLen;
        [consumed, keyLen] = VarInt.decode(pointer.sliceBuffer(buffer));
        pointer.consume(consumed, 'incorrect packet length (keyLen)');
        pointer.assert(keyLen, 'insufficient data (key)');
        key = new StringTableKey(
          pointer.sliceBuffer(buffer, keyLen).toString()
        );
        pointer.consume(keyLen, 'incorrect packet length (key)');
        break;
      }

      case TableKeyType.SINT: {
        pointer.assert(4, 'insufficient data (key)');
        key = new SignedInt32TableKey(buffer.readInt32BE(pointer.get()));
        pointer.consume(4, 'incorrect packet length (key)');
        break;
      }

      case TableKeyType.IPv4: {
        const keyLen = tableDefinition.keyLen;
        pointer.assert(keyLen, 'insufficient data (key)');
        key = new IPv4TableKey(inet_ntop(pointer.sliceBuffer(buffer, keyLen)));
        pointer.consume(keyLen, 'incorrect packet length (key)');
        break;
      }

      case TableKeyType.IPv6: {
        const keyLen = tableDefinition.keyLen;
        pointer.assert(keyLen, 'insufficient data (key)');
        key = new IPv6TableKey(inet_ntop(pointer.sliceBuffer(buffer, keyLen)));
        pointer.consume(keyLen, 'incorrect packet length (key)');
        break;
      }

      default:
        throw new Error(
          `Unable to handle key type '${tableDefinition.keyType as string}'.`
        );
    }

    const values: Map<DataType, TableValue<unknown>> = new Map();
    for (const dataTypeDefinition of tableDefinition.dataTypeDefinitions) {
      const dataType = dataTypeDefinition.dataType;
      const decodedType = getDecodedType(dataType);
      debug(
        'data type is %s (%d) which is a %s',
        DataType[dataType],
        dataType,
        DecodedType[decodedType]
      );

      switch (decodedType) {
        case DecodedType.SINT: {
          let decodedInt: number;
          [consumed, decodedInt] = VarInt.decode(pointer.sliceBuffer(buffer));
          pointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );
          values.set(dataType, new SignedInt32TableValue(decodedInt));
          break;
        }
        }

        case DecodedType.UINT:
        case DecodedType.ULONGLONG: {
          let decodedInt: number;
          [consumed, decodedInt] = VarInt.decode(pointer.sliceBuffer(buffer));
          pointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          values.set(
            dataType,
            decodedType === DecodedType.UINT
              ? new UnsignedInt32TableValue(decodedInt)
              : new UnsignedInt64TableValue(decodedInt)
          );
          break;
        }

        case DecodedType.FREQUENCY_COUNTER: {
          let currentTick: number;
          [consumed, currentTick] = VarInt.decode(pointer.sliceBuffer(buffer));
          pointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          let currentCounter: number;
          [consumed, currentCounter] = VarInt.decode(
            pointer.sliceBuffer(buffer)
          );
          pointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          let previousCounter: number;
          [consumed, previousCounter] = VarInt.decode(
            pointer.sliceBuffer(buffer)
          );
          pointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          values.set(
            dataType,
            new FrequencyCounterTableValue({
              currentTick,
              currentCounter,
              previousCounter,
            })
          );
          break;
        }

        case DecodedType.DICTIONARY: {
          let lengthOfEntry: number;
          [consumed, lengthOfEntry] = VarInt.decode(
            pointer.sliceBuffer(buffer)
          );
          pointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          if (lengthOfEntry === 0) {
            values.set(dataType, new DictionaryTableValue(null));
            break;
          }

          const entryBuffer = pointer.sliceBuffer(
            buffer,
            lengthOfEntry,
            `Insufficient data (value for '${dataType}')`
          );
          const entryPointer = new Pointer(lengthOfEntry);

          let entryId: number;
          [consumed, entryId] = VarInt.decode(entryBuffer);
          entryPointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          if (entryPointer.isEmpty()) {
            const cached = this.dictionaryCache.get(entryId);
            if (cached === undefined) {
              throw new Error(`Unknown dictionary cache entry '${entryId}'`);
            }
            values.set(dataType, new DictionaryTableValue(cached));
            pointer.consume(
              lengthOfEntry,
              `Incorrect packet length (value for '${dataType}')`
            );
            break;
          }

          let stringLength: number;
          [consumed, stringLength] = VarInt.decode(
            entryBuffer.slice(entryPointer.get())
          );
          entryPointer.consume(
            consumed,
            `Incorrect packet length (value for '${dataType}')`
          );

          const stringOffset = entryPointer.get();
          entryPointer.assert(
            stringLength,
            `Insufficient data (value for '${dataType}')`
          );
          const value = entryBuffer
            .slice(stringOffset, stringOffset + stringLength)
            .toString();
          entryPointer.consume(
            stringLength,
            `Incorrect packet length (value for '${dataType}')`
          );

          if (!entryPointer.isEmpty()) {
            throw new Error(
              `Incorrect packet length (value for '${dataType}')`
            );
          }

          this.dictionaryCache.set(entryId, value);
          values.set(dataType, new DictionaryTableValue(value));
          pointer.consume(
            lengthOfEntry,
            `Incorrect packet length (value for '${dataType}')`
          );
          break;
        }

        case DecodedType.ARRAY: {
          const count = dataTypeDefinition.count;
          if (count === undefined) {
            throw new Error(`Missing array length for '${DataType[dataType]}'`);
          }

          const elementType = getArrayElementType(dataType);
          const items: unknown[] = [];
          for (let i = 0; i < count; i++) {
            switch (elementType) {
              case DecodedType.UINT: {
                let value: number;
                [consumed, value] = VarInt.decode(pointer.sliceBuffer(buffer));
                pointer.consume(
                  consumed,
                  `Incorrect packet length (value for '${dataType}')`
                );
                items.push(value);
                break;
              }

              case DecodedType.FREQUENCY_COUNTER: {
                let currentTick: number;
                [consumed, currentTick] = VarInt.decode(
                  pointer.sliceBuffer(buffer)
                );
                pointer.consume(
                  consumed,
                  `Incorrect packet length (value for '${dataType}')`
                );

                let currentCounter: number;
                [consumed, currentCounter] = VarInt.decode(
                  pointer.sliceBuffer(buffer)
                );
                pointer.consume(
                  consumed,
                  `Incorrect packet length (value for '${dataType}')`
                );

                let previousCounter: number;
                [consumed, previousCounter] = VarInt.decode(
                  pointer.sliceBuffer(buffer)
                );
                pointer.consume(
                  consumed,
                  `Incorrect packet length (value for '${dataType}')`
                );

                items.push({
                  currentTick,
                  currentCounter,
                  previousCounter,
                });
                break;
              }

              default:
                throw new Error(
                  `Unable to handle array element type '${DecodedType[elementType]}'`
                );
            }
          }

          values.set(dataType, new ArrayTableValue(items));
          break;
        }

        default:
          throw new Error(
            `unable to handle decoded data type ${DecodedType[decodedType]}`
          );
      }
    }

    if (!pointer.isEmpty()) {
      throw new Error('incorrect packet length (total)');
    }

    const update = {
      updateId,
      expiry,
      key,
      values,
    };

    this.lastUpdateId = update.updateId;

    this.push(new messages.EntryUpdate(tableDefinition, update));

    return pointer.get();
  }

  _transform(
    chunk: Buffer,
    _encoding: string,
    callback: TransformCallback
  ): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      let pointer = 0;
      for (;;) {
        const consumed = this.parseMessage(this.buffer.slice(pointer));

        if (consumed === null) {
          break;
        }

        pointer += consumed;
      }

      this.buffer = Buffer.from(this.buffer.slice(pointer));

      callback();
    } catch (err) {
      const errorMessage = 'error parsing message';
      if (err instanceof Error) {
        let stack = '';
        if (err.stack) {
          stack = err.stack;
        }
        callback(new Error(`${errorMessage}: ${stack}`));
      } else if (typeof err === 'string') {
        callback(new Error(`${errorMessage}: ${err}`));
      } else {
        callback(new Error(errorMessage));
      }
    }
  }
}

export default PeerParser;
