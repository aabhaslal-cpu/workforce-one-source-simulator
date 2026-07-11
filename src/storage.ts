import type { ScenarioState, Snapshot } from "./domain.js";

export interface SimulatorStorage {
  listScenarioStates(): ScenarioState[];
  getScenarioState(scenarioId: string): ScenarioState | undefined;
  saveScenarioState(state: ScenarioState): void;
  createSnapshot(snapshot: Snapshot): void;
  getSnapshot(snapshotId: string): Snapshot | undefined;
  listSnapshots(): Snapshot[];
  replaceScenarioStates(states: ScenarioState[]): void;
}

export class MemorySimulatorStorage implements SimulatorStorage {
  private readonly states = new Map<string, ScenarioState>();
  private readonly snapshots = new Map<string, Snapshot>();

  listScenarioStates(): ScenarioState[] {
    return [...this.states.values()].map(cloneState);
  }

  getScenarioState(scenarioId: string): ScenarioState | undefined {
    const state = this.states.get(scenarioId);
    return state ? cloneState(state) : undefined;
  }

  saveScenarioState(state: ScenarioState): void {
    this.states.set(state.scenarioId, cloneState(state));
  }

  createSnapshot(snapshot: Snapshot): void {
    this.snapshots.set(snapshot.snapshotId, {
      ...snapshot,
      states: snapshot.states.map(cloneState),
    });
  }

  getSnapshot(snapshotId: string): Snapshot | undefined {
    const snapshot = this.snapshots.get(snapshotId);
    return snapshot ? { ...snapshot, states: snapshot.states.map(cloneState) } : undefined;
  }

  listSnapshots(): Snapshot[] {
    return [...this.snapshots.values()].map((snapshot) => ({
      ...snapshot,
      states: snapshot.states.map(cloneState),
    }));
  }

  replaceScenarioStates(states: ScenarioState[]): void {
    this.states.clear();
    for (const state of states) {
      this.saveScenarioState(state);
    }
  }
}

function cloneState(state: ScenarioState): ScenarioState {
  return JSON.parse(JSON.stringify(state)) as ScenarioState;
}
