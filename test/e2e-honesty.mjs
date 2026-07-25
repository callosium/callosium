// Unit test for M4 recall relationship-honesty (isRelationshipQuery + relationshipHonesty).
//   node test/e2e-honesty.mjs
import { isRelationshipQuery, relationshipHonesty } from '../src/recall/engine.ts';

let pass = 0,
  fail = 0;
const ok = (n, c) => {
  if (c) {
    pass++;
    console.log('  ✓ ' + n);
  } else {
    fail++;
    console.log('  ✗ ' + n);
  }
};

// ── isRelationshipQuery: gates personal-role questions only ──
ok('gates "who is my manager"', isRelationshipQuery('who is my manager'));
ok('gates "who is my direct manager" (multi-word)', isRelationshipQuery('who is my direct manager'));
ok('gates "who are my managers" (plural)', isRelationshipQuery('who are my managers'));
ok('gates "who are my bosses" (es-plural)', isRelationshipQuery('who are my bosses'));
ok("gates \"who're my managers\" (contraction)", isRelationshipQuery("who're my managers"));
ok('gates "who is my wife"', isRelationshipQuery('who is my wife'));
ok('gates "who are our parents"', isRelationshipQuery('who are our parents'));
ok('does NOT gate "who is our client" (often an org)', !isRelationshipQuery('who is our client'));
ok('does NOT gate "who is my partner"', !isRelationshipQuery('who is my partner'));
ok('does NOT gate "who is our vendor"', !isRelationshipQuery('who is our vendor'));
ok('does NOT gate "who is Robert" (a name, no my/our)', !isRelationshipQuery('who is Robert'));
ok('does NOT gate topical "what is the espresso ratio"', !isRelationshipQuery('what is the espresso ratio'));

// ── relationshipHonesty: gate a non-person top hit, pass a person, ignore non-relationship ──
const texts = {
  texts: new Map([
    ['Partners/Microsoft.md', '---\ntype: partner\n---\naccount manager: X'],
    ['People/Sam.md', '---\ntype: person\n---\nmy manager'],
    ['Contacts/Jane.md', '---\ntype: contact\n---\nmy manager Jane'],
  ]),
  mtimes: new Map(),
  contentIndex: null,
};
const partnerTop = { found: true, results: [{ path: 'Partners/Microsoft.md' }] };
const personTop = { found: true, results: [{ path: 'People/Sam.md' }] };
ok('gates non-person top hit -> found:false', relationshipHonesty('who is my manager', partnerTop, texts).found === false);
ok('passes person top hit -> found stays true', relationshipHonesty('who is my manager', personTop, texts).found === true);
ok('adopted-vault person (unknown type, not People/) fails OPEN', relationshipHonesty('who is my manager', { found: true, results: [{ path: 'Contacts/Jane.md' }] }, texts).found === true);
ok('non-relationship query untouched', relationshipHonesty('what is the ratio', partnerTop, texts).found === true);
ok('gated answer carries an honest reason', !!relationshipHonesty('who is my boss', partnerTop, texts).notInBrainReason);

console.log(`\n  ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
console.log('  ALL PASS');
