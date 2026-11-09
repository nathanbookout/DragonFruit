"use client";

import React from 'react';
import { SupportSymmetryAxis, SupportSymmetryMode, SupportSymmetryScope, SupportSymmetrySettings } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';
import { FieldHelpTooltip } from '@/components/settings/profileFormAtoms';

interface SupportSymmetryCardProps {
    symmetry: SupportSymmetrySettings;
    onChange: (symmetry: Partial<SupportSymmetrySettings>) => void;
}

type MirrorAxisKey = 'x' | 'y' | 'z';

const AXIS_KEYS: MirrorAxisKey[] = ['x', 'y', 'z'];

const MODES: { value: SupportSymmetryMode; label: string }[] = [
    { value: 'off', label: 'Off' },
    { value: 'mirror', label: 'Mirror' },
    { value: 'radial', label: 'Radial' },
];

const SCOPES: { value: SupportSymmetryScope; label: string }[] = [
    { value: 'global', label: 'Global' },
    { value: 'local', label: 'Local' },
];

const RADIAL_AXES: SupportSymmetryAxis[] = ['x', 'y', 'z'];

const MODE_HELP = 'Places extra supports automatically when you click one. Off: one support per click. Mirror: also places a copy reflected across the chosen axis planes. Radial: also places copies rotated evenly around an axis. Each copy is routed on its own, so it avoids the model like a normal click would, and it is only placed where the model actually has a matching surface.';
const FRAME_HELP = 'Where the mirror planes / rotation axis sit. Global: through the scene origin (build plate centre), aligned to the printer X/Y/Z, so it only matches models that are themselves centred on it. Local: through the model\'s own bounding-box centre and along its own orientation, so symmetry follows the model wherever it is placed or rotated.';
const MIRROR_AXES_HELP = 'Each enabled axis mirrors across the plane perpendicular to it (X mirrors left/right, Y front/back, Z top/bottom). Enabling several combines them, e.g. X+Y gives up to four supports per click.';
const RADIAL_AXIS_HELP = 'The axis copies are rotated around. Z (vertical) suits parts that are round when seen from above.';
const RADIAL_COUNT_HELP = 'Total number of evenly spaced positions around the axis, including the one you clicked (e.g. 6 = every 60°).';
const TOLERANCE_HELP = 'When a support is placed, a mirrored/rotated copy is added only if the model surface has a matching contact point within this distance of the symmetric location. Larger values place copies on less precisely symmetric models; smaller values require near-exact symmetry.';

const activeStyle: React.CSSProperties = {
    borderColor: 'color-mix(in srgb, var(--accent), var(--border-subtle) 36%)',
    background: 'color-mix(in srgb, var(--accent), var(--surface-1) 88%)',
    color: 'color-mix(in srgb, var(--accent), var(--text-strong) 25%)',
};

const inactiveStyle: React.CSSProperties = {
    borderColor: 'var(--border-subtle)',
    background: 'var(--surface-1)',
    color: 'var(--text-muted)',
};

export function SupportSymmetryCard({ symmetry, onChange }: SupportSymmetryCardProps) {
    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base text-center no-spinners';
    const active = symmetry.mode !== 'off';

    return (
        <div className="space-y-2.5">
            <span className="text-[11px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                Mode
                <FieldHelpTooltip label="Symmetry mode" help={MODE_HELP} />
            </span>
            <div className="grid grid-cols-3 gap-1.5">
                {MODES.map((option) => (
                    <button
                        key={option.value}
                        type="button"
                        role="switch"
                        aria-checked={symmetry.mode === option.value}
                        onClick={() => onChange({ mode: option.value })}
                        className="ui-input h-[36px] inline-flex items-center justify-center text-[13px] font-semibold leading-none"
                        style={symmetry.mode === option.value ? activeStyle : inactiveStyle}
                    >
                        {option.label}
                    </button>
                ))}
            </div>

            {active && (
                <div className="space-y-1">
                    <span className="text-[11px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>Symmetry frame<FieldHelpTooltip label="Symmetry frame" help={FRAME_HELP} /></span>
                    <div className="grid grid-cols-2 gap-1.5">
                        {SCOPES.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                role="switch"
                                aria-checked={symmetry.scope === option.value}
                                onClick={() => onChange({ scope: option.value })}
                                className="ui-input h-[36px] inline-flex items-center justify-center text-[13px] font-semibold leading-none"
                                style={symmetry.scope === option.value ? activeStyle : inactiveStyle}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {symmetry.mode === 'mirror' && (
                <div className="space-y-1">
                    <span className="text-[11px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>Mirror axes<FieldHelpTooltip label="Mirror axes" help={MIRROR_AXES_HELP} /></span>
                    <div className="grid grid-cols-3 gap-1.5">
                        {AXIS_KEYS.map((axis) => (
                            <button
                                key={axis}
                                type="button"
                                role="switch"
                                aria-checked={symmetry[axis]}
                                onClick={() => onChange({ [axis]: !symmetry[axis] })}
                                className="ui-input h-[36px] inline-flex items-center justify-center text-[13px] font-semibold leading-none"
                                style={symmetry[axis] ? activeStyle : inactiveStyle}
                            >
                                {axis.toUpperCase()}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {symmetry.mode === 'radial' && (
                <>
                    <div className="space-y-1">
                        <span className="text-[11px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>Radial axis<FieldHelpTooltip label="Radial axis" help={RADIAL_AXIS_HELP} /></span>
                        <div className="grid grid-cols-3 gap-1.5">
                            {RADIAL_AXES.map((axis) => (
                                <button
                                    key={axis}
                                    type="button"
                                    role="radio"
                                    aria-checked={symmetry.radialAxis === axis}
                                    onClick={() => onChange({ radialAxis: axis })}
                                    className="ui-input h-[36px] inline-flex items-center justify-center text-[13px] font-semibold leading-none"
                                    style={symmetry.radialAxis === axis ? activeStyle : inactiveStyle}
                                >
                                    {axis.toUpperCase()}
                                </button>
                            ))}
                        </div>
                    </div>
                    <label className="flex flex-col gap-0.5 w-full">
                        <span className="text-[11px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>Symmetry count<FieldHelpTooltip label="Symmetry count" help={RADIAL_COUNT_HELP} /></span>
                        <NumberInput
                            value={symmetry.radialCount}
                            step={1}
                            showStepper={false}
                            onChange={(val) => onChange({ radialCount: Math.max(2, Math.min(64, Math.round(val))) })}
                            className={compactInputClass}
                        />
                    </label>
                </>
            )}

            {active && (
                <label className="flex flex-col gap-0.5 w-full">
                    <span className="text-[11px] font-medium inline-flex items-center gap-1.5" style={{ color: 'var(--text-muted)' }}>
                        Contact tolerance
                        <FieldHelpTooltip label="Contact tolerance" help={TOLERANCE_HELP} />
                    </span>
                    <div className="relative">
                        <NumberInput
                            value={symmetry.toleranceMm}
                            step={0.1}
                            showStepper={false}
                            onChange={(val) => onChange({ toleranceMm: Math.max(0, Math.min(10, val)) })}
                            className={`${compactInputClass} w-full`}
                        />
                        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold" style={{ color: 'var(--text-muted)' }}>mm</span>
                    </div>
                </label>
            )}
        </div>
    );
}
