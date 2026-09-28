/** Connection-epoch gate for expensive host.acked side effects.
 *
 * Cloud correctly acknowledges every 30s host declaration heartbeat. Runtime
 * ownership/profile/upgrade fields must still be processed on every ack, but
 * transport probing and memory/asset catch-up belong to the accepted WS
 * connection epoch, not to every heartbeat.
 */
export class HostAckCatchupGate {
  private epoch = 0;
  private heavyWorkspace = '';
  private transportSuccess = '';
  private transportInFlight = '';

  onConnected(): void {
    this.epoch += 1;
    this.heavyWorkspace = '';
    this.transportSuccess = '';
    this.transportInFlight = '';
  }

  takeHeavyCatchup(workspaceId: string): boolean {
    if (this.heavyWorkspace === workspaceId) return false;
    this.heavyWorkspace = workspaceId;
    return true;
  }

  /** Returns true only when this call performed and completed the report. */
  async runTransportOnce(workspaceId: string, report: () => Promise<void>): Promise<boolean> {
    if (this.transportSuccess === workspaceId || this.transportInFlight === workspaceId) return false;
    const epoch = this.epoch;
    this.transportInFlight = workspaceId;
    try {
      await report();
      if (this.epoch === epoch) this.transportSuccess = workspaceId;
      return true;
    } catch {
      return false;
    } finally {
      if (this.epoch === epoch && this.transportInFlight === workspaceId) this.transportInFlight = '';
    }
  }
}
