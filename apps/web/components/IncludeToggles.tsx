"use client";

import { INCLUDE_KEYS, INCLUDE_LABELS, type BrandInclude, type BrandKit, type IncludeKey } from "@clipforge/contracts";

const ASSET_FIELD: Partial<Record<IncludeKey, keyof BrandKit>> = {
  intro: "introAssetId",
  outro: "outroAssetId",
  music: "musicAssetId",
  logo: "logoAssetId",
};

/** True when the brand kit has a file for this piece (captions are always available). */
export function isAvailable(key: IncludeKey, kit: BrandKit | null | undefined): boolean {
  const field = ASSET_FIELD[key];
  return !field || Boolean(kit?.[field]);
}

/** Intro / Outro / Music / Logo / Captions checkboxes. Pieces with no file set up are greyed out. */
export function IncludeToggles({
  value,
  onChange,
  brandKit,
  size = "sm",
}: {
  value: BrandInclude;
  onChange: (next: BrandInclude) => void;
  brandKit: BrandKit | null | undefined;
  size?: "sm" | "xs";
}) {
  return (
    <div className={`flex flex-wrap gap-x-5 gap-y-2 ${size === "xs" ? "text-xs" : "text-sm"}`}>
      {INCLUDE_KEYS.map((key) => {
        const available = isAvailable(key, brandKit);
        return (
          <label
            key={key}
            className={`flex items-center gap-2 ${available ? "" : "text-zinc-600"}`}
            title={available ? "" : "Add one in Settings → Brand kit"}
          >
            <input
              type="checkbox"
              className="accent-brand-500"
              disabled={!available}
              checked={available && value[key]}
              onChange={(e) => onChange({ ...value, [key]: e.target.checked })}
            />
            {INCLUDE_LABELS[key]}
          </label>
        );
      })}
    </div>
  );
}
