// Read-only synthetic transport: every request stays in an in-memory fixture.
// Production identity→session→native code is exercised, not a fixed namespace.
// Counts do not imply measured VPS latency or deployment validation.
import {measureIdentityNativeCosts} from '../tests/helpers/account-identity-fixture.mjs';
const before=await measureIdentityNativeCosts({ready:false}),after=await measureIdentityNativeCosts({ready:true});
console.log(JSON.stringify({syntheticOnly:true,unchangedFileProtocol:true,before,after},null,2));
