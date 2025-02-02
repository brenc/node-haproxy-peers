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
import * as types from './types';

export interface Message {} // eslint-disable-line @typescript-eslint/no-empty-interface

export class TableDefinition implements Message {
  constructor(public readonly definition: types.TableDefinition) {}
}

export class Heartbeat implements Message {}

export class SynchronizationRequest implements Message {}

export class SynchronizationConfirmed implements Message {}

export class SynchronizationPartial implements Message {}

export class SynchronizationFull implements Message {}

export class EntryUpdate implements Message {
  constructor(
    public readonly tableDefinition: types.TableDefinition,
    public readonly update: types.EntryUpdate
  ) {}
}
