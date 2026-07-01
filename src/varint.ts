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

/**
 * Decodes the given buffer as a varint.
 *
 * Returns a pair containing the number of consumed bytes and the parsed int.
 *
 * @param buffer the buffer to decode.
 * @returns a two element array containing the number of consumed bytes and the
 * parsed int.
 */
export function decode(buffer: Buffer): [number, number] {
  const [consumed, value] = decodeBigInt(buffer);
  return [consumed, Number(value)];
}

/**
 * Decodes the given buffer as a varint.
 *
 * Returns a pair containing the number of consumed bytes and the parsed int.
 *
 * @param buffer the buffer to decode.
 * @returns a two element array containing the number of consumed bytes and the
 * parsed int.
 */
export function decodeBigInt(buffer: Buffer): [number, bigint] {
  if (buffer.length < 1) {
    throw new Error('insufficient data');
  }

  const first = buffer[0];
  if ((first & 0b11110000) !== 0b11110000) {
    return [1, BigInt(first)];
  }

  let val = BigInt(first);
  let shift = 4n;
  for (let i = 1; i < buffer.length; i++) {
    const byte = buffer[i];
    val += BigInt(byte) << shift;

    if ((byte & 0b10000000) === 0) {
      return [i + 1, val];
    }

    shift += 7n;
  }

  throw new Error('insufficient data');
}

/**
 * Encodes an integer to an HAProxy VarInt.
 *
 * @param int the integer to encode.
 * @returns a Buffer containing the given `int` encoded as an HAProxy VarInt.
 */
export function encode(int: number | bigint): Buffer {
  let value = BigInt(int);
  if (value < 0n) {
    throw new Error('negative values are not supported');
  }

  if (value < 0xf0n) {
    return Buffer.from([Number(value)]);
  }

  const result = [];
  result.push(Number(value & 0xffn) | 0xf0);

  value -= 0xf0n;
  value >>= 4n;

  while (value >= 0x80n) {
    result.push(Number(value & 0x7fn) | 0x80);
    value -= 0x80n;
    value >>= 7n;
  }

  result.push(Number(value));

  return Buffer.from(result);
}
