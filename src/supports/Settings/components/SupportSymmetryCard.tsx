"use client";

import React from 'react';
import { CircleHelp } from 'lucide-react';
import { SupportSymmetryAxis, SupportSymmetryMode, SupportSymmetryScope, SupportSymmetrySettings } from '../types';
import { NumberInput } from '@/components/ui/NumberInput';
import { MouseTooltip } from '@/components/ui/MouseTooltip';

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

function HelpTip({ help }: { help: string }) {
    const [hovered, setHovered] = React.useState(false);
    return (
        <span
            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border cursor-help relative"
            style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface-0)', color: 'var(--text-muted)' }}
            tabIndex={0}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            aria-label={help}
        >
            <CircleHelp className="h-2.5 w-2.5" />
            <MouseTooltip visible={hovered} offset={{ x: 0, y: 28 }} className="left-1/2 -translate-x-1/2">
                <div
                    className="rounded px-2 py-1.5 text-[11px] leading-tight font-medium shadow-lg"
                    style={{
                        background: 'rgba(24, 24, 24, 0.98)',
                        color: 'var(--text-strong, #e0e0e0)',
                        border: '1px solid var(--accent, #baf72e)',
                        maxWidth: 260,
                        whiteSpace: 'normal',
                        textAlign: 'left',
                    }}
                >
                    {help}
                </div>
            </MouseTooltip>
        </span>
    );
}

export function SupportSymmetryCard({ symmetry, onChange }: SupportSymmetryCardProps) {
    const compactInputClass = 'ui-input w-full h-[36px] px-3 py-2 text-base text-center no-spinners';
    const active = symmetry.mode !== 'off';

    return (
        <div className="space-y-2.5">
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
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Symmetry frame</span>
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
                    <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Mirror axes</span>
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
                        <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Radial axis</span>
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
                        <span className="text-[11px] font-medium" style={{ color: 'var(--text-muted)' }}>Symmetry count</span>
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
                        <HelpTip help={TOLERANCE_HELP} />
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
