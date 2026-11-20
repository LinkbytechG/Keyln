import {splitView} from '../../dist/packages/contracts/index.js';

// T94: a page sends only what changed. Tests that still build a whole page-shaped candidate (the shape every test used before T94) turn it into that request
// the way the page does: split it against the base it was made from, and carry the revision numbers it was made on (`candidate.revision` is the library's,
// `candidate.layoutRevision` the layout's; a missing layout revision is the base's).
export const saveRequest=(base,candidate)=>({libraryRevision:candidate.revision,layoutName:candidate.layoutName??base.layoutName,layoutRevision:candidate.layoutRevision??base.layoutRevision,...splitView(base,candidate)});
