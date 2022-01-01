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
  TableKeyType,
  DataType,
  DecodedType,
  FrequencyCounter,
} from './wire-types';

export abstract class TableKey<T> {
  abstract readonly type: TableKeyType;
  abstract readonly key: T;
}

export class SignedInt32TableKey extends TableKey<number> {
  readonly type = TableKeyType.SINT;

  constructor(public readonly key: number) {
    super();
  }
}

export class StringTableKey extends TableKey<string> {
  readonly type = TableKeyType.STRING;

  constructor(public readonly key: string) {
    super();
  }
}

export class IPv6TableKey extends TableKey<string> {
  readonly type = TableKeyType.IPv6;

  constructor(public readonly key: string) {
    super();
  }
}

export class IPv4TableKey extends TableKey<string> {
  readonly type = TableKeyType.IPv4;

  constructor(public readonly key: string) {
    super();
  }
}

export abstract class TableValue<T> {
  abstract readonly type: DecodedType;
  abstract readonly value: T;
}

export class SignedInt32TableValue extends TableValue<number> {
  readonly type = DecodedType.SINT;

  constructor(public value: number) {
    super();
  }
}

export class UnsignedInt32TableValue extends TableValue<number> {
  readonly type = DecodedType.UINT;

  constructor(public value: number) {
    super();
  }
}

export class UnsignedInt64TableValue extends TableValue<number> {
  readonly type = DecodedType.ULONGLONG;

  constructor(public value: number) {
    super();
  }
}

export class FrequencyCounterTableValue extends TableValue<FrequencyCounter> {
  readonly type = DecodedType.FREQUENCY_COUNTER;

  constructor(public value: FrequencyCounter) {
    super();
  }
}

export interface TableDefinition {
  senderTableId: number;
  name: string;
  keyType: TableKeyType;
  keyLen: number;
  dataTypes: readonly DataType[];
  expiry: number;
}

export interface EntryUpdate {
  updateId: number;
  expiry: number | null;
  key: TableKey<unknown>;
  values: ReadonlyMap<DataType, TableValue<unknown>>;
}
