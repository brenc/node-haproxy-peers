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

import Backoff from 'backo2';
import d from 'debug';
import { EventEmitter } from 'events';
import net from 'net';
import util from 'util';

import * as messages from './messages';
import * as VarInt from './varint';
import PeerParser from './protocol-parser';
import {
  ControlMessageClass,
  MessageClass,
  StatusMessageCode,
  UpdateMessageType,
} from './wire-types';
import { EntryUpdate, TableDefinition } from './types';
import { Message } from './messages';

const debug = d('haproxy-peers:connection');

export enum PeerDirection {
  OUT,
  IN,
}

// TODO: add backoff options.
export interface PeerConnectionOptions {
  direction: PeerDirection;
  hostname: string;
  myName: string;
  peerName?: string;
  port: number;
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

export interface PeerConnection {
  emit(event: 'error', err: Error): boolean;

  emit(
    event: 'entryUpdate',
    entry: EntryUpdate,
    tableDefinition: TableDefinition
  ): boolean;

  emit(event: 'synchronizationFinished', type: SynchronizationType): boolean;

  emit(event: 'synchronizationStarted'): boolean;

  emit(event: 'tableDefinition', tableDefinition: TableDefinition): boolean;

  on(event: 'error', listener: (err: Error) => void): this;

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
  private backoff: Backoff;
  private heartbeatTimer?: NodeJS.Timeout;
  private parser: PeerParser = this.createParser();
  private socket: net.Socket;
  private state: PeerConnectionState = PeerConnectionState.NOT_STARTED;

  constructor(private options: PeerConnectionOptions) {
    super();

    if (options.peerName === undefined) {
      options.peerName = options.hostname;
    }

    if (options.direction !== PeerDirection.OUT) {
      throw new Error('only outgoing connections are supported');
    }

    this.backoff = new Backoff({ min: 1000, max: 10000 });

    this.socket = this.connect(options.hostname, options.port);

    // setInterval(() => {
    //   debug('READY STATE: %s', this.socket.readyState);
    //   debug('IS PAUSED:', this.socket.isPaused(), this.parser.isPaused());
    // }, 1000);
  }

  private createParser(): PeerParser {
    const parser = new PeerParser();

    parser
      .on('close', () => {
        debug('parser closed');
      })

      .on('data', (message: Message) => {
        debug('parser message');
        this.onParserMessage(message);
      })

      .on('end', () => {
        debug('parser ended');
      })

      .on('error', (err) => {
        debug('parser error: %o', err);
        this.socket.destroy(err);
      })

      .on('resume', () => {
        debug('parser resumed');
      });

    return parser;
  }

  private connect(hostname: string, port: number) {
    debug('connecting to %s:%s', hostname, port);

    const socket = net.connect(port, hostname);

    socket
      .on('close', () => {
        const duration = this.backoff.duration();

        debug('socket closed, reconnecting in %dms', duration);

        if (this.heartbeatTimer) {
          debug('stopping heartbeats');
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        }

        setTimeout(() => {
          debug('attempting reconnect');

          this.socket.destroy();
          this.socket.unpipe();

          this.state = PeerConnectionState.NOT_STARTED;

          // The old parser gets ended and there doesn't appear to be a way to
          // re-use it, so we create a new one.
          this.parser = this.createParser();

          this.socket = this.connect(hostname, port);
        }, duration);
      })

      .on('connect', () => {
        debug('socket connected');
        // TODO: this resets too fast.
        // this.backoff.reset();
      })

      // close will be called directly after this
      .on('error', (err) => {
        debug('socket error: %o', err);
      })

      .on('ready', () => {
        debug('socket ready');

        this.start(true)
          .then(() => {
            debug('peer connection successfully started');
          })

          .catch((err: Error) => {
            let stack: string;
            if (err.stack) {
              stack = err.stack;
            } else {
              stack = '[no stack]';
            }

            this.emit(
              'error',
              new Error(`error starting peer connection: ${stack}`)
            );
          });
      })

      .on('timeout', () => {
        debug('socket timeout');
        // This isn't done automatically.
        socket.destroy(new Error('socket timeout'));
      });

    return socket;
  }

  /**
   * Starts peer processing on this connection.
   *
   * Will perform the handshake, start the heartbeat timer and then pass any
   * future data to the protocol parser.
   *
   * @param autoSynchronization Whether to send a synchronization request
   * after performing the handshake.
   */
  async start(autoSynchronization = false) {
    debug('starting connection');

    if (this.state !== PeerConnectionState.NOT_STARTED) {
      throw new Error('a peer connection can only be started once');
    }

    this.sendHello();
    this.state = PeerConnectionState.AWAITING_HANDSHAKE_REPLY;

    try {
      const status = await this.readStatus();

      if (status === StatusMessageCode.HANDSHAKE_SUCCEEDED) {
        // From here on out, the parser handles the data stream.
        this.socket.pipe(this.parser);

        this.state = PeerConnectionState.ESTABLISHED;

        this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 3000);

        if (autoSynchronization) {
          this.sendSychronizationRequest();
        }
      } else {
        throw new Error(`got an unexpected status: ${status}`);
      }
    } catch (err) {
      this.socket.destroy();
      throw err;
    }
  }

  start2() {
    debug('starting connection');

    if (this.state !== PeerConnectionState.NOT_STARTED) {
      throw new Error('a peer connection can only be started once');
    }

    this.socket.pipe(this.parser);

    this.sendHello();

    this.state = PeerConnectionState.AWAITING_HANDSHAKE_REPLY;
  }

  requestSynchronization(): void {
    this.sendSychronizationRequest();
  }

  private sendHello(): void {
    const helloMessage = `HAProxyS 2.1\n${
      this.options.peerName || this.options.hostname
    }\n${this.options.myName} 0 0\n`;

    this.socket.write(helloMessage);

    debug('sent hello message "%o"', helloMessage);
  }

  /**
   * Reads the connection status after a "hello" message is sent.
   */
  private async readStatus(): Promise<number> {
    debug('reading status');

    // This is written like this so we can convert the event based interface
    // of a socket/stream into a promise.
    return new Promise((resolve, reject) => {
      // Only get the first four bytes, which should be the numeric status
      // plus a newline (e.g. '200\n').
      // We're using .once('readable') to get the status only. After this
      // the socket stream is piped into the protocol parser which handles
      // message parsing from then on.
      this.socket.once('readable', () => {
        const chunk = this.socket.read(4) as Buffer;

        debug('status chunk: %o', chunk.toString());

        // Only pull out the first three bytes which should be the status
        // code excluding the newline, then convert to an int.
        // e.g. '200\n' -> 200
        const statusCode = parseInt(chunk.slice(0, 3).toString(), 10);

        debug('got status code %d', statusCode);

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

  private onParserMessage(message: Message) {
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
