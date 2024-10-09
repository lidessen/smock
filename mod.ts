interface Smock {
  use: (config: SmockListener) => void;
}

interface SmockListener {
  match: (url: string) => boolean;
  open?: (event: Event, socket: WebSocket) => Promise<void>;
  message?: (data: string, socket: WebSocket) => Promise<string>;
  send?: (data: string, socket: WebSocket) => Promise<string>;
  error?: (event: Event, socket: WebSocket) => Promise<void>;
  close?: (event: CloseEvent, socket: WebSocket) => Promise<void>;
}

export function init() {
  const OriginalWebSocket = globalThis.WebSocket;

  const smockListeners: SmockListener[] = [];

  class ProxyWebSocket {
    private socket: WebSocket;
    private listeners: SmockListener[];
    private eventListeners: Map<
      string,
      Set<EventListenerOrEventListenerObject>
    >;

    constructor(url: string, protocols?: string | string[]) {
      console.log("[ProxyWebSocket] New WebSocket constructed.");
      this.listeners = smockListeners.filter((listener) => listener.match(url));
      this.socket = new OriginalWebSocket(url, protocols);
      this.eventListeners = new Map();

      return new Proxy(this, {
        get: (target, prop, receiver) => {
          if (prop === "addEventListener") {
            return target.addEventListener.bind(target);
          } else if (prop === "removeEventListener") {
            return target.removeEventListener.bind(target);
          } else if (prop === "close") {
            // deno-lint-ignore no-explicit-any
            return (...args: any[]) => target.socket.close(...args);
          } else if (prop in target) {
            return Reflect.get(target, prop, receiver);
          } else {
            return Reflect.get(target.socket, prop, target.socket);
          }
        },
        set: (target, prop, value) => {
          if (prop in target) {
            return Reflect.set(target, prop, value);
          } else {
            return Reflect.set(target.socket, prop, value);
          }
        },
      });
    }

    private async modifyIncomingMessage(
      data: string,
    ): Promise<string | void> {
      let modifiedData = data;
      try {
        for (const listener of this.listeners) {
          if (listener.message) {
            modifiedData = await listener.message(
              data,
              this.socket,
            );
          }
        }
        return modifiedData;
      } catch (e: unknown) {
        console.error("Error modifying incoming message:", e);
        return data;
      }
    }

    private async modifyOutgoingMessage(data: string): Promise<string> {
      let modifiedData = data;
      try {
        for (const listener of this.listeners) {
          if (listener.send) {
            modifiedData = await listener.send(data, this.socket);
          }
        }
        return modifiedData;
      } catch (e: unknown) {
        console.error("Error modifying outgoing message:", e);
        return data;
      }
    }

    async send(data: string): Promise<void> {
      const modifiedData = await this.modifyOutgoingMessage(data);
      this.socket.send(modifiedData);
    }

    addEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ): void {
      if (!this.eventListeners.has(type)) {
        this.eventListeners.set(type, new Set());
      }
      this.eventListeners.get(type)!.add(listener);

      const wrappedListener = async (event: Event) => {
        if (type === "message") {
          const messageEvent = event as MessageEvent;
          const modifiedData = await this.modifyIncomingMessage(
            messageEvent.data,
          );
          if (modifiedData) {
            const customEvent = new MessageEvent("message", {
              ...messageEvent,
              data: modifiedData,
              ports: [...messageEvent.ports], // Spread to create a mutable array
            });
            if (typeof listener === "function") {
              listener.call(this, customEvent);
            } else if (listener.handleEvent) {
              listener.handleEvent(customEvent);
            }
          }
        } else {
          if (typeof listener === "function") {
            listener.call(this, event);
          } else if (listener.handleEvent) {
            listener.handleEvent(event);
          }
        }
      };

      this.socket.addEventListener(type, wrappedListener);
    }

    removeEventListener(
      type: string,
      listener: EventListenerOrEventListenerObject,
    ): void {
      const listeners = this.eventListeners.get(type);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.eventListeners.delete(type);
        }
      }
      this.socket.removeEventListener(type, listener as EventListener);
    }
  }

  globalThis.WebSocket = ProxyWebSocket as unknown as typeof WebSocket;
  const smock: Smock = {
    use: (config: SmockListener) => {
      smockListeners.push(config);
    },
  };
  Reflect.defineProperty(globalThis, "smock", {
    get() {
      return smock;
    },
  });
}
