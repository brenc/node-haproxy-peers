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

export enum MessageClass {
  CONTROL = 0,
  ERROR = 1,
  UPDATE = 10,
  RESERVED = 255,
}

export enum ControlMessageClass {
  SYNCHRONIZATION_REQUEST = 0,
  SYNCHRONIZATION_FINISHED = 1,
  SYNCHRONIZATION_PARTIAL = 2,
  SYNCHRONIZATION_CONFIRMED = 3,
  HEARTBEAT = 4,
}

export enum UpdateMessageType {
  ENTRY_UPDATE = 128,
  INCREMENTAL_ENTRY_UPDATE = 129,
  STICK_TABLE_DEFINITION = 130,
  STICK_TABLE_SWITCH = 131,
  ACK = 132,
  ENTRY_UPDATE_TIMED = 133,
  INCREMENTAL_ENTRY_UPDATE_TIMED = 134,
}

export enum DataType {
  SERVER_ID = 0,
  GPT0 = 1,
  GPC0 = 2,
  GPC0_RATE = 3,
  CONN_CNT = 4,
  CONN_RATE = 5,
  CONN_CUR = 6,
  SESS_CNT = 7,
  SESS_RATE = 8,
  HTTP_REQ_CNT = 9,
  HTTP_REQ_RATE = 10,
  HTTP_ERR_CNT = 11,
  HTTP_ERR_RATE = 12,
  BYTES_IN_CNT = 13,
  BYTES_IN_RATE = 14,
  BYTES_OUT_CNT = 15,
  BYTES_OUT_RATE = 16,
  GPC1 = 17,
  GPC1_RATE = 18,
  HTTP_FAIL_CNT = 20,
  HTTP_FAIL_RATE = 21,
}

export enum DecodedType {
  // Signed integer.
  SINT,
  // Unsigned integer.
  UINT,
  // Unsigned long.
  ULONGLONG,
  FREQUENCY_COUNTER,
  DICTIONARY,
}

export interface FrequencyCounter {
  currentTick: DecodedType.UINT;
  currentCounter: DecodedType.UINT;
  previousCounter: DecodedType.UINT;
}

export function getDecodedType(dataType: DataType): DecodedType {
  switch (dataType) {
    case DataType.SERVER_ID:
      return DecodedType.SINT;

    case DataType.CONN_CNT:
    case DataType.CONN_CUR:
    case DataType.GPC0:
    case DataType.GPC1:
    case DataType.GPT0:
    case DataType.HTTP_ERR_CNT:
    case DataType.HTTP_REQ_CNT:
    case DataType.SESS_CNT:
    case DataType.HTTP_FAIL_CNT:
      return DecodedType.UINT;

    case DataType.BYTES_IN_CNT:
    case DataType.BYTES_OUT_CNT:
      return DecodedType.ULONGLONG;

    case DataType.BYTES_IN_RATE:
    case DataType.BYTES_OUT_RATE:
    case DataType.CONN_RATE:
    case DataType.GPC0_RATE:
    case DataType.GPC1_RATE:
    case DataType.HTTP_ERR_RATE:
    case DataType.HTTP_REQ_RATE:
    case DataType.SESS_RATE:
    case DataType.HTTP_FAIL_RATE:
      return DecodedType.FREQUENCY_COUNTER;

    default:
      throw new Error(`Unhandled DataType ${dataType as string}`);
  }
}

export enum StatusMessageCode {
  HANDSHAKE_SUCCEEDED = 200,
  TRY_AGAIN_LATER = 300,
  PROTOCOL_ERROR = 501,
  BAD_VERSION = 502,
  LOCAL_PEER_IDENTIFIER_MISMATCH = 503,
  REMOTE_PEER_IDENTIFIER_MISMATCH = 504,
}

export enum TableKeyType {
  SINT = 2,
  IPv4 = 4,
  IPv6 = 5,
  STRING = 6,
  BINARY = 7,
}
