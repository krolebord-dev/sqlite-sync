export interface HLC {
  timestamp: number;
  counter: number;
  nodeId: string;
}

export class HLCCounter {
  private timestamp: number;
  private counter: number;
  private nodeId: string;

  private readonly getTimestamp: () => number;

  constructor(nodeId: string, getTimestamp: () => number) {
    this.timestamp = getTimestamp();
    this.counter = 0;
    this.nodeId = nodeId;
    this.getTimestamp = getTimestamp;
  }

  getCurrentHLC(): HLC {
    return {
      timestamp: this.timestamp,
      counter: this.counter,
      nodeId: this.nodeId,
    };
  }

  getNextHLC(): HLC {
    const now = this.getTimestamp();

    if (now > this.timestamp) {
      this.timestamp = now;
      this.counter = 0;
      return this.getCurrentHLC();
    }

    this.counter++;
    return this.getCurrentHLC();
  }

  mergeHLC(hlc: HLC) {
    if (this.timestamp === hlc.timestamp) {
      this.counter = Math.max(this.counter, hlc.counter) + 1;
    } else if (this.timestamp > hlc.timestamp) {
      this.counter++;
    } else {
      this.timestamp = hlc.timestamp;
      this.counter = hlc.counter + 1;
    }
  }
}

export function serializeHLC(hlc: HLC) {
  return (
    hlc.timestamp.toString().padStart(15, "0") +
    ":" +
    hlc.counter.toString(36).padStart(5, "0") +
    ":" +
    hlc.nodeId
  );
}

export function deserializeHLC(serialized: string) {
  const [ts, count, ...node] = serialized.split(":");
  return {
    timestamp: parseInt(ts),
    counter: parseInt(count, 36),
    nodeId: node.join(":"),
  };
}

export function compareHLC(one: HLC, two: HLC) {
  if (one.timestamp == two.timestamp) {
    if (one.counter === two.counter) {
      if (one.nodeId === two.nodeId) {
        return 0;
      }
      return one.nodeId < two.nodeId ? -1 : 1;
    }
    return one.counter - two.counter;
  }
  return one.timestamp - two.timestamp;
}
