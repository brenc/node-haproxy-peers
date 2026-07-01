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
import { EventEmitter } from 'events';
import net from 'net';
import tls from 'tls';
import { StickTableStore } from './aggregator';
import {
  DictionaryEncoder,
  encodeAck,
  encodeControlMessage,
  encodeEntryUpdate,
  encodeStatus,
  encodeTableDefinition,
} from './encoder';
import * as messages from './messages';
import { Message } from './messages';
import PeerParser from './protocol-parser';
import { EntryUpdate, TableDefinition } from './types';
import {
  ControlMessageClass,
  DEFAULT_PROTOCOL_VERSION,
  StatusMessageCode,
} from './wire-types';

const debug = d('haproxy-peers:server');

/**
 * Upper bound on the plaintext handshake. The hello is three short lines, so a
 * peer that sends more than this without completing it is treated as hostile
 * and disconnected rather than letting the buffer grow without bound.
 */
const MAX_HANDSHAKE_SIZE = 4096;

export interface PeerServerOptions {
  /** Name this peer announces itself as; must match the HAProxy peer config. */
  localName: string;
  /** Protocol version to accept (defaults to {@link DEFAULT_PROTOCOL_VERSION}). */
  protocolVersion?: string;
  /** Optional store that received updates are aggregated into and served from. */
  store?: StickTableStore;
  /**
   * Maximum number of simultaneous inbound connections. When set, further
   * connections are refused until existing ones close. Defaults to unlimited.
   */
  maxConnections?: number;
  /**
   * When provided, the server terminates TLS instead of accepting plaintext
   * connections. Pass a server `key`/`cert` here; for mutual TLS also set
   * `requestCert: true`, `rejectUnauthorized: true`, and the trusted `ca` so
   * Node refuses unauthorized clients before the peer handshake begins.
   */
  tls?: tls.TlsOptions;
}

interface ParsedHello {
  protocolVersion: string;
  remoteName: string;
  senderName: string;
}

function parseHello(text: string): ParsedHello | null {
  const lines = text.split('\n');
  if (lines.length < 3) {
    return null;
  }

  const [magicLine, remoteName, senderLine] = lines;
  const magic = magicLine.split(' ');
  if (magic[0] !== 'HAProxyS') {
    throw new Error(`unexpected handshake magic '${magic[0]}'`);
  }

  return {
    protocolVersion: magic[1] ?? '',
    remoteName,
    senderName: senderLine.split(' ')[0] ?? '',
  };
}

export interface InboundPeerConnection {
  emit(event: 'error', err: Error): boolean;
  emit(event: 'established', hello: ParsedHello): boolean;
  emit(event: 'close'): boolean;
  emit(event: 'tableDefinition', tableDefinition: TableDefinition): boolean;
  emit(
    event: 'entryUpdate',
    entry: EntryUpdate,
    tableDefinition: TableDefinition
  ): boolean;

  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'established', listener: (hello: ParsedHello) => void): this;
  on(event: 'close', listener: () => void): this;
  on(
    event: 'tableDefinition',
    listener: (tableDefinition: TableDefinition) => void
  ): this;
  on(
    event: 'entryUpdate',
    listener: (entry: EntryUpdate, tableDefinition: TableDefinition) => void
  ): this;
}

/**
 * Handles a single inbound peer connection (a remote HAProxy or peer that
 * connected to us). Performs the server side of the handshake, feeds received
 * updates into the optional store, and teaches the store back to peers that
 * request a synchronization.
 */
export class InboundPeerConnection extends EventEmitter {
  private readonly parser = new PeerParser();
  private readonly dictionary = new DictionaryEncoder();
  private handshakeBuffer = Buffer.alloc(0);
  private established = false;
  private heartbeatTimer?: NodeJS.Timeout;
  private definitionsByName = new Map<string, TableDefinition>();

  constructor(
    private readonly socket: net.Socket,
    private readonly options: PeerServerOptions
  ) {
    super();

    this.socket.on('error', (err) => this.emit('error', err));
    this.socket.on('close', () => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
      }
      this.emit('close');
    });

    this.parser.on('data', (message: Message) => this.onParserMessage(message));
    this.parser.on('error', (err: Error) => {
      this.socket.destroy();
      this.emit('error', err);
    });

    this.socket.on('data', (chunk: Buffer) => this.onHandshakeData(chunk));
  }

  private onHandshakeData(chunk: Buffer): void {
    if (this.established) {
      return;
    }

    this.handshakeBuffer = Buffer.concat([this.handshakeBuffer, chunk]);

    // The hello spans three newline-terminated lines.
    const text = this.handshakeBuffer.toString();
    const newlineCount = text.split('\n').length - 1;
    if (newlineCount < 3) {
      if (this.handshakeBuffer.length > MAX_HANDSHAKE_SIZE) {
        debug('rejecting handshake: exceeded %d bytes', MAX_HANDSHAKE_SIZE);
        this.socket.write(encodeStatus(StatusMessageCode.PROTOCOL_ERROR));
        this.socket.destroy();
      }
      return;
    }

    let hello: ParsedHello | null;
    try {
      hello = parseHello(text);
    } catch (err) {
      this.socket.write(encodeStatus(StatusMessageCode.PROTOCOL_ERROR));
      this.socket.destroy();
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (hello === null) {
      return;
    }

    const expectedVersion =
      this.options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    if (hello.protocolVersion !== expectedVersion) {
      debug('rejecting handshake: bad version %s', hello.protocolVersion);
      this.socket.write(encodeStatus(StatusMessageCode.BAD_VERSION));
      this.socket.destroy();
      return;
    }

    if (hello.remoteName !== this.options.localName) {
      debug('rejecting handshake: name mismatch %s', hello.remoteName);
      this.socket.write(
        encodeStatus(StatusMessageCode.REMOTE_PEER_IDENTIFIER_MISMATCH)
      );
      this.socket.destroy();
      return;
    }

    this.socket.write(encodeStatus(StatusMessageCode.HANDSHAKE_SUCCEEDED));
    this.established = true;

    // Anything already buffered past the handshake belongs to the binary
    // stream and must be handed to the parser before piping the rest.
    const headerEnd = nthNewlineOffset(this.handshakeBuffer, 3);
    const leftover = this.handshakeBuffer.slice(headerEnd);
    this.socket.removeAllListeners('data');
    this.socket.pipe(this.parser);
    if (leftover.length > 0) {
      this.parser.write(leftover);
    }

    this.heartbeatTimer = setInterval(() => {
      this.socket.write(encodeControlMessage(ControlMessageClass.HEARTBEAT));
    }, 3000);

    this.emit('established', hello);
  }

  private onParserMessage(message: Message): void {
    if (message instanceof messages.Heartbeat) {
      debug('received heartbeat');
    } else if (message instanceof messages.TableDefinition) {
      this.definitionsByName.set(message.definition.name, message.definition);
      this.options.store?.applyDefinition(message.definition);
      this.emit('tableDefinition', message.definition);
    } else if (message instanceof messages.EntryUpdate) {
      this.socket.write(
        encodeAck(
          message.tableDefinition.senderTableId,
          message.update.updateId
        )
      );
      this.options.store?.applyUpdate(message.tableDefinition, message.update);
      this.emit('entryUpdate', message.update, message.tableDefinition);
    } else if (message instanceof messages.SynchronizationRequest) {
      this.teach();
    } else if (
      message instanceof messages.SynchronizationPartial ||
      message instanceof messages.SynchronizationFull
    ) {
      this.socket.write(
        encodeControlMessage(ControlMessageClass.SYNCHRONIZATION_CONFIRMED)
      );
    }
  }

  /**
   * Replays the current store contents to the peer in response to a
   * synchronization request, then signals that the full sync is complete.
   */
  private teach(): void {
    const store = this.options.store;
    if (store === undefined) {
      // Nothing to teach: report an empty full sync so the peer proceeds.
      this.socket.write(
        encodeControlMessage(ControlMessageClass.SYNCHRONIZATION_PARTIAL)
      );
      return;
    }

    for (const tableName of store.getTableNames()) {
      const definition = store.getDefinition(tableName);
      if (definition === undefined) {
        continue;
      }

      this.socket.write(encodeTableDefinition(definition));

      let updateId = 1;
      for (const entry of store.getEntries(tableName)) {
        const update: EntryUpdate = {
          updateId: updateId++,
          expiry: entry.expiry,
          key: entry.key,
          values: entry.values,
        };
        this.socket.write(
          encodeEntryUpdate(definition, update, this.dictionary)
        );
      }
    }

    // A "full" teach is signalled to HAProxy via the partial control message.
    this.socket.write(
      encodeControlMessage(ControlMessageClass.SYNCHRONIZATION_PARTIAL)
    );
  }
}

function nthNewlineOffset(buffer: Buffer, n: number): number {
  let found = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0x0a) {
      found++;
      if (found === n) {
        return i + 1;
      }
    }
  }
  return buffer.length;
}

export interface PeerServer {
  emit(event: 'error', err: Error): boolean;
  emit(event: 'connection', connection: InboundPeerConnection): boolean;
  emit(event: 'listening'): boolean;

  on(event: 'error', listener: (err: Error) => void): this;
  on(
    event: 'connection',
    listener: (connection: InboundPeerConnection) => void
  ): this;
  on(event: 'listening', listener: () => void): this;
}

/**
 * Accepts inbound peer connections and exposes each one as an
 * {@link InboundPeerConnection}. When constructed with a store, received
 * updates are aggregated into it and served back to peers that synchronize.
 */
export class PeerServer extends EventEmitter {
  private readonly server: net.Server;

  constructor(private readonly options: PeerServerOptions) {
    super();

    const onConnection = (socket: net.Socket): void => {
      const connection = new InboundPeerConnection(socket, this.options);
      this.emit('connection', connection);
    };

    this.server =
      this.options.tls !== undefined
        ? tls.createServer(this.options.tls, onConnection)
        : net.createServer(onConnection);

    if (this.options.maxConnections !== undefined) {
      this.server.maxConnections = this.options.maxConnections;
    }

    this.server.on('error', (err) => this.emit('error', err));
    this.server.on('listening', () => this.emit('listening'));
  }

  listen(port: number, hostname?: string): void {
    this.server.listen(port, hostname);
  }

  address(): net.AddressInfo | string | null {
    return this.server.address();
  }

  close(callback?: (err?: Error) => void): void {
    this.server.close(callback);
  }
}

export default PeerServer;
