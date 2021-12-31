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

import { PeerConnection, PeerDirection, SynchronizationType } from './';
import { DataType } from './wire-types';

const debug = d('haproxy-peers:demo');

function connect() {
  debug('connecting');

  const conn = new PeerConnection({
    myName: 'tracker',
    hostname: 'test-proxy',
    // peerName: 'test-proxy',
    port: 8102,
    direction: PeerDirection.OUT,
  });

  conn
    .on('error', (err) => {
      console.error('peer connection error: %o', err);
    })

    .on('tableDefinition', (def) => {
      debug(`received table definition "${def.name}":`, def);
    })

    .on('entryUpdate', (update, def) => {
      debug(
        `received entry update for table "${def.name}", key '${
          update.key.key as string
        }':`,
        new Map(
          Array.from(update.values.entries()).map(([k, v]) => {
            return [DataType[k], v];
          })
        )
      );
    })

    .on('synchronizationStarted', () => {
      debug(`synchronization started`);
    })

    .on('synchronizationFinished', (type: SynchronizationType) => {
      debug(`Finished sync ${type}`);
    });
}

connect();
