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

import * as messages from './messages';
import * as VarInt from './varint';
import d from 'debug';
import PeerParser from './protocol-parser';
import {
  ControlMessageClass,
  MessageClass,
  StatusMessageCode,
  UpdateMessageType,
} from './wire-types';
import { Duplex } from 'stream';
import { EntryUpdate, TableDefinition } from './types';
import { EventEmitter } from 'events';
import { Message } from './messages';

const debug = d('manager:haproxy:peers:connection');

export enum PeerDirection {
  OUT,
  IN,
}

export interface PeerConnectionOptions {
  direction: PeerDirection;
  myName: string;
  peerName: string;
}

export enum SynchronizationType {
  PARTIAL = 'partial',
  FULL = 'full',
}

enum PeerConnectionState {
  NOT_STARTED,
  INITIAL,
  AWAITING_HANDSHAKE_REPLY,
  ESTABLISHED,
  DEAD,
}

export declare interface PeerConnection {
  emit(
    event: 'entryUpdate',
    entry: EntryUpdate,
    tableDefinition: TableDefinition
  ): boolean;
  emit(event: 'synchronizationFinished', type: SynchronizationType): boolean;
  emit(event: 'synchronizationStarted'): boolean;
  emit(event: 'tableDefinition', tableDefinition: TableDefinition): boolean;
  on(
    event: 'entryUpdate',
    listener: (entry: EntryUpdate, tableDefinition: TableDefinition) => void
  ): this;
  on(
    event: 'synchronizationFinished',
    listener: (type: SynchronizationType) => void
  ): this;
  on(event: 'synchronizationStarted', listener: () => void): this;
  on(
    event: 'tableDefinition',
    listener: (tableDefinition: TableDefinition) => void
  ): this;
  once(
    event: 'entryUpdate',
    listener: (entry: EntryUpdate, tableDefinition: TableDefinition) => void
  ): this;
  once(
    event: 'synchronizationFinished',
    listener: (type: SynchronizationType) => void
  ): this;
  once(event: 'synchronizationStarted', listener: () => void): this;
  once(
    event: 'tableDefinition',
    listener: (tableDefinition: TableDefinition) => void
  ): this;
}

export class PeerConnection extends EventEmitter {
  private parser: PeerParser = new PeerParser();
  private state: PeerConnectionState = PeerConnectionState.NOT_STARTED;
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(private socket: Duplex, private options: PeerConnectionOptions) {
    super();

    if (options.direction !== PeerDirection.OUT) {
      throw new Error(
        'Handling of non-outgoing connections is not yet implemented.'
      );
    }

    this.parser.on('data', (message: Message) => {
      this.handle(message);
    });

    this.parser.on('error', (err) => {
      this.socket.destroy(err);
    });

    this.socket.on('close', () => {
      if (this.heartbeatTimer) {
        debug('stopping heartbeats');
        clearInterval(this.heartbeatTimer);
      }
    });
  }

  /**
   * Starts peer processing on this connection.
   *
   * Will perform the handshake, start the heartbeat timer and then pass any future data to the protocol parser.
   *
   * @param autoSynchronization Whether to send a synchronization request after performing the handshake.
   */
  async start(autoSynchronization = false) {
    if (this.state !== PeerConnectionState.NOT_STARTED) {
      throw new Error('A connection can only be started once');
    }

    switch (this.options.direction) {
      case PeerDirection.OUT:
        // TODO: wait until the socket is ready before sending anything.
        this.sendHello();
        this.state = PeerConnectionState.AWAITING_HANDSHAKE_REPLY;

        try {
          const status = await this.readStatus();
          debug('received status %s', status);

          if (status === StatusMessageCode.HANDSHAKE_SUCCEEDED) {
            this.state = PeerConnectionState.ESTABLISHED;
            this.socket.pipe(this.parser);

            this.sendHeartbeat();
            this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 1500);

            if (autoSynchronization) {
              this.sendSychronizationRequest();
            }
          } else {
            throw new Error(`Unexpected status '${status}'.`);
          }
        } catch (err) {
          if (err instanceof Error) {
            this.socket.destroy(err);
          }
        }

        break;
      case PeerDirection.IN:
        throw new Error('Not yet implemented, see constructor()');
    }
  }

  requestSynchronization(): void {
    this.sendSychronizationRequest();
  }

  private sendHello(): void {
    debug('sending hello');

    this.socket.write(
      `HAProxyS 2.1\n${this.options.peerName}\n${this.options.myName} 0 0\n`
    );
  }

  /**
   * Reads the connection status after a "hello" message is sent.
   */
  private async readStatus(): Promise<number> {
    return new Promise((resolve, reject) => {
      // This will read everything in the buffer which at this point should
      // only be the four byte status. The status is small enough such that we
      // should be able to read it in one chunk, but technically speaking we
      // should really loop through the buffer until it's actually empty.
      //
      // We're using .once('readable') to get the status only. After this
      // the socket stream is piped into the protocol parser which handles
      // data parsing from then on.
      this.socket.once('readable', () => {
        const chunks: Buffer[] = [];
        for (;;) {
          const chunk = this.socket.read() as Buffer;
          if (!chunk) {
            break;
          }
          chunks.push(chunk);
        }

        const data = Buffer.concat(chunks);
        if (data.length !== 4) {
          return reject(
            new Error(
              `error reading status: message length should be 4 bytes, got ` +
                `${data.length} byte(s)`
            )
          );
        }

        // Converts a buffer with '200\n' -> 200.
        const statusCode = parseInt(data.toString().slice(0, -1), 10);

        switch (statusCode) {
          case StatusMessageCode.BAD_VERSION:
          case StatusMessageCode.HANDSHAKE_SUCCEEDED:
          case StatusMessageCode.LOCAL_PEER_IDENTIFIER_MISMATCH:
          case StatusMessageCode.PROTOCOL_ERROR:
          case StatusMessageCode.REMOTE_PEER_IDENTIFIER_MISMATCH:
          case StatusMessageCode.TRY_AGAIN_LATER:
            resolve(statusCode);
            break;

          default:
            reject(
              new Error(
                `error reading status: invalid status message code: ` +
                  `${statusCode}`
              )
            );
        }
      });

      this.socket.once('error', reject);
    });
  }

  private sendHeartbeat(): void {
    debug('sending heartbeat');

    this.socket.write(
      Buffer.from([MessageClass.CONTROL, ControlMessageClass.HEARTBEAT])
    );
  }

  private sendSychronizationRequest(): void {
    debug('sending synchronization request');

    this.socket.write(
      Buffer.from([
        MessageClass.CONTROL,
        ControlMessageClass.SYNCHRONIZATION_REQUEST,
      ])
    );

    this.emit('synchronizationStarted');
  }

  private sendSynchronizationConfirmed(): void {
    debug('sending synchronization confirmed');

    this.socket.write(
      Buffer.from([
        MessageClass.CONTROL,
        ControlMessageClass.SYNCHRONIZATION_CONFIRMED,
      ])
    );
  }

  private sendSynchronizationFinished(
    type: SynchronizationType = SynchronizationType.PARTIAL
  ): void {
    debug('sending %s synchronization finished', type);

    switch (type) {
      case SynchronizationType.PARTIAL:
        this.socket.write(
          Buffer.from([
            MessageClass.CONTROL,
            ControlMessageClass.SYNCHRONIZATION_FINISHED,
          ])
        );
        break;

      case SynchronizationType.FULL:
        this.socket.write(
          Buffer.from([
            MessageClass.CONTROL,
            ControlMessageClass.SYNCHRONIZATION_PARTIAL,
          ])
        );
        break;
    }
  }

  private sendAck(tableId: number, updateId: number): void {
    debug('sending ack for update %d in table %d', updateId, tableId);

    const encodedTableId = VarInt.encode(tableId);
    const encodedUpdateId = Buffer.alloc(4);
    encodedUpdateId.writeUInt32BE(updateId, 0);

    const ack = Buffer.concat([
      Buffer.from([MessageClass.UPDATE, UpdateMessageType.ACK]),
      VarInt.encode(encodedTableId.length + 4),
      encodedTableId,
      encodedUpdateId,
    ]);

    this.socket.write(ack);
  }

  private handle(message: Message) {
    if (message instanceof messages.Heartbeat) {
      debug('received heartbeat');
    } else if (message instanceof messages.TableDefinition) {
      debug('received table definition');
      this.emit('tableDefinition', message.definition);
    } else if (message instanceof messages.SynchronizationRequest) {
      debug('received synchronization request');
      this.sendSynchronizationFinished();
    } else if (message instanceof messages.SynchronizationPartial) {
      debug('finished partial synchronization');
      this.sendSynchronizationConfirmed();
      this.emit('synchronizationFinished', SynchronizationType.PARTIAL);
    } else if (message instanceof messages.SynchronizationFull) {
      debug('finished full synchronization');
      this.sendSynchronizationConfirmed();
      this.emit('synchronizationFinished', SynchronizationType.FULL);
    } else if (message instanceof messages.EntryUpdate) {
      debug('received entry update');
      this.sendAck(
        message.tableDefinition.senderTableId,
        message.update.updateId
      );
      this.emit('entryUpdate', message.update, message.tableDefinition);
    }
  }
}

export default PeerConnection;
