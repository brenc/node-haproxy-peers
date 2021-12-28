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

import net from 'net';
import d from 'debug';
import {
  PeerConnection,
  PeerDirection,
  TableDefinition,
  EntryUpdate,
  SynchronizationType,
} from './haproxy/peers';
import { DataType } from './haproxy/peers/wire-types';

const debug = d('manager:demo');

function reconnect() {
  debug('connecting');

  const socket = net.connect(8102, 'test-proxy');

  const conn = new PeerConnection(socket, {
    myName: 'tracker',
    peerName: 'test-proxy',
    direction: PeerDirection.OUT,
  });

  socket.on('close', () => setTimeout(reconnect, 500));

  socket.on('error', (e) => {
    debug(e);
  });

  conn.on('tableDefinition', (def: TableDefinition) => {
    debug(`Received table defition ${def.name}:`, def);
  });

  conn.on('entryUpdate', (update: EntryUpdate, def: TableDefinition) => {
    debug(
      `Received entry update in table ${def.name} for key '${
        update.key.key as string
      }':`,
      new Map(
        Array.from(update.values.entries()).map(([k, v]) => {
          return [DataType[k], v];
        })
      )
    );
  });

  conn.on('synchronizationStarted', () => {
    debug(`Started sync`);
  });

  conn.on('synchronizationFinished', (type: SynchronizationType) => {
    debug(`Finished sync ${type}`);
  });

  conn.start(true);
}
reconnect();
