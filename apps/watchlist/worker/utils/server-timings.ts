export class ServerTimings {
  private timings: [string, number][] = [];

  async time<T>(name: string, fn: () => Promise<T>) {
    const start = performance.now();
    const result = await fn();
    const end = performance.now();
    this.timings.push([name, end - start]);
    return result;
  }

  getSerializedTimings() {
    return this.timings.map(([name, time]) => `${name};dur=${time}`).join(',');
  }
}
