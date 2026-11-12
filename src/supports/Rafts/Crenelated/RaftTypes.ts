import * as THREE from 'three';

export type RaftBottomMode = 'off' | 'solid' | 'line';

export function isRaftBottomMode(value: unknown): value is RaftBottomMode {
  return value === 'off' || value === 'solid' || value === 'line';
}

/**
 * What the raft footprint covers.
 * - `supports`: hull of the support roots only (upstream behaviour).
 * - `supportsAndModel`: also the model's convex hull projected onto the plate,
 *   grown by `modelFootprintMarginPct`.
 */
export type RaftFootprintMode = 'supports' | 'supportsAndModel';

export interface RaftSettings {
  bottomMode: RaftBottomMode;
  wallEnabled: boolean;
  thickness: number;           // mm
  chamferAngle: number;        // degrees (45-90)
  wallHeight: number;          // mm
  wallThickness: number;       // mm
  crenulationGapWidth: number; // mm
  crenulationSpacing: number;  // mm
  lineWidthMm: number;         // mm
  lineHeightMm: number;        // mm
  showFootprintBorder: boolean; // Show combined model+raft footprint border
  footprintBorderMargin: number; // mm - margin beyond raft/model edge
  footprintMode: RaftFootprintMode;
  modelFootprintMarginPct: number; // % the projected model hull is grown about its centroid
  raftAvoidsModel: boolean; // cut the raft out where a model stands on the plate (upstream behaviour)
}

export interface RaftGeometry {
  baseProfile: THREE.Vector2[];      // 2D footprint points
  baseMesh: THREE.Mesh;         // Main raft plate
  wallMesh: THREE.Mesh;         // Perimeter wall with crenulations
  boundingBox: THREE.Box3;      // For collision detection
}

// Input representation for a support base footprint circle
export interface SupportBaseCircle {
  x: number;   // center X in mm
  y: number;   // center Y in mm
  r: number;   // radius in mm (half of base diameter)
}

// Options for computing raft footprint from support base circles
export interface ComputeFootprintOptions {
  marginMm?: number;       // additional outward buffer beyond circle radius
  samplesPerCircle?: number; // number of points to sample per circle (>=8)
}

export type FootprintProfile = THREE.Vector2[];
