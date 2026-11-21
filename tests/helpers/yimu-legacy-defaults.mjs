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
// `overrides` lets a fixture pin further values on top (since 0.8.69 every automatic summary
// needs its trigger met and ends three floors before the newest, so a fixture that wants an
// automatic round on its short synthetic chat states its own floor trigger).
export async function seedLegacyDefaults(account, overrides = {}) {
    const value = createDefaults();
    value.values = {...value.values, ...LEGACY_SETTINGS, ...overrides};
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
