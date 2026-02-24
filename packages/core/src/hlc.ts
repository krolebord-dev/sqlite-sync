export interface HLC {
  timestamp: number;
  counter: number;
  nodeId: string;
}

const MAX_COUNTER = 36 ** 5 - 1; // 60,466,175 — max value that fits in 5-char base36

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
    if (this.counter > MAX_COUNTER) {
      throw new Error(`HLC counter overflow: exceeded max value ${MAX_COUNTER}`);
    }
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
    if (this.counter > MAX_COUNTER) {
      throw new Error(`HLC counter overflow: exceeded max value ${MAX_COUNTER}`);
    }
  }
}

export function serializeHLC(hlc: HLC) {
  return `${hlc.timestamp.toString().padStart(15, "0")}:${hlc.counter.toString(36).padStart(5, "0")}:${hlc.nodeId}`;
}

export function deserializeHLC(serialized: string): HLC {
  const parts = serialized.split(":");
  if (parts.length < 3) {
    throw new Error(`Invalid HLC format: expected at least 3 colon-separated segments, got ${parts.length}`);
  }

  const timestamp = parseInt(parts[0], 10);
  const counter = parseInt(parts[1], 36);

  if (Number.isNaN(timestamp) || Number.isNaN(counter)) {
    throw new Error(`Invalid HLC values: timestamp=${parts[0]}, counter=${parts[1]}`);
  }

  return {
    timestamp,
    counter,
    nodeId: parts.slice(2).join(":"),
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
