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
  EntryUpdate,
  FrequencyCounterTableValue,
  SignedInt32TableValue,
  TableDefinition,
  TableKey,
  TableValue,
  UnsignedInt32TableValue,
  UnsignedInt64TableValue,
} from './types';
import {
  DataType,
  DecodedType,
  FrequencyCounter,
  getArrayElementType,
  getDecodedType,
} from './wire-types';

/**
 * Merges two values of the same data type that originate from different peers.
 * `existing` is the value already held by the store (or `undefined` when the
 * key was previously unseen) and `incoming` is the newly received value.
 */
export type MergeStrategy = (
  dataType: DataType,
  existing: TableValue<unknown> | undefined,
  incoming: TableValue<unknown>
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
  incoming: FrequencyCounter
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
  incoming
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
          (incoming as FrequencyCounterTableValue).value
        )
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
            mergeFrequencyCounters(a as FrequencyCounter, b as FrequencyCounter)
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
      existing?.values ?? []
    );
    for (const [dataType, value] of update.values) {
      values.set(
        dataType,
        this.merge(dataType, existing?.values.get(dataType), value)
      );
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
