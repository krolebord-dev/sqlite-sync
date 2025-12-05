export class TypedBroadcastChannel<TMessage> {
  private readonly channel: BroadcastChannel;

  constructor(name: string) {
    this.channel = new BroadcastChannel(name);
  }

  postMessage(message: TMessage) {
    this.channel.postMessage(message);
  }

  set onmessage(callback: (event: MessageEvent<TMessage>) => void) {
    this.channel.onmessage = callback;
  }
}
