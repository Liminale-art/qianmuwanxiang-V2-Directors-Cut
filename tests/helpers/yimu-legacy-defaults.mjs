import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createDefaults} from '../../yimu/contract.mjs';

// Fixtures written before the 0.8.20 defaults (recent 3, triggerFloors 10) describe
// their floor arithmetic with five recent originals and token-only triggering.
// Pinning those values keeps each scenario's meaning; the new defaults have their own tests.
export const LEGACY_SETTINGS = Object.freeze({recent: 5, triggerFloors: 0});

// Seeds <account>/.yimu/defaults.json at revision 0 in the store's checksum envelope,
// so revision assertions in the fixtures are unchanged.
export async function seedLegacyDefaults(account) {
    const value = createDefaults();
    value.values = {...value.values, ...LEGACY_SETTINGS};
    const folder = path.join(account, '.yimu');
    await fs.mkdir(folder, {recursive: true});
    const checksum = createHash('sha256').update(JSON.stringify(value)).digest('hex');
    await fs.writeFile(path.join(folder, 'defaults.json'), JSON.stringify({schema: 1, value, checksum}), 'utf8');
}

// Unit-test counterparts of DEFAULTS / createDefaults() with the legacy values pinned.
export const legacySettings = defaults => Object.freeze({...defaults, ...LEGACY_SETTINGS});
export function legacyDefaults() {
    const value = createDefaults();
    value.values = {...value.values, ...LEGACY_SETTINGS};
    return value;
}
