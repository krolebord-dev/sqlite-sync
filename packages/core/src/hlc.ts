export interface HLC {
  timestamp: number;
  counter: number;
  nodeId: string;
}

/** Maximum allowed clock drift (60 seconds) before capping to wall clock */
const MAX_CLOCK_DRIFT_MS = 60_000;

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
    const now = this.getTimestamp();
    const maxTimestamp = Math.max(now, this.timestamp, hlc.timestamp);

    if (maxTimestamp - now > MAX_CLOCK_DRIFT_MS) {
      console.warn(`HLC drift too large (${maxTimestamp - now}ms), capping to wall clock`);
      this.timestamp = now;
      this.counter = 0;
      return;
    }

    if (maxTimestamp === this.timestamp && maxTimestamp === hlc.timestamp) {
      this.counter = Math.max(this.counter, hlc.counter) + 1;
    } else if (maxTimestamp === this.timestamp) {
      this.counter++;
    } else if (maxTimestamp === hlc.timestamp) {
      this.timestamp = hlc.timestamp;
      this.counter = hlc.counter + 1;
    } else {
      // now is the largest
      this.timestamp = now;
      this.counter = 0;
    }
  }
}

export function serializeHLC(hlc: HLC) {
  return `${hlc.timestamp.toString().padStart(15, "0")}:${hlc.counter.toString(36).padStart(5, "0")}:${hlc.nodeId}`;
}

export function deserializeHLC(serialized: string) {
  const [ts, count, ...node] = serialized.split(":");
  return {
    timestamp: parseInt(ts, 10),
    counter: parseInt(count, 36),
    nodeId: node.join(":"),
  };
}

export function compareHLC(one: HLC, two: HLC) {
  if (one.timestamp === two.timestamp) {
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
