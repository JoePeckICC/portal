'use strict';
// The master intake form (2026-09-27): every question from "InCadence Care — Master Intake Form (Build Spec)",
// with its conditional logic, tiers, modes and per-area depth control. Question numbers match the PDF.
//
// Text tokens (the page swaps them for the patient's name, or "you" when the patient is filling it out):
//   {NAME} you / Sam      {NAME_CAP} You / Sam      {NAME_S} your / Sam's      {NAME_CAP_S} Your / Sam's
//   {DOES} Do you / Does Sam      {IS} are you / is Sam      {HAS} Have you / Has Sam      {WAS} were you / was Sam
//   [[family|patient]]  two wordings: the first when family fills it out, the second when the patient does
//   {HELPER} the main caregiver's name (or "you")    {HELPER_DOES} Do you / Does Pat    {HELPER_IS} Are you / Is Pat
//
// Question fields:
//   req      Tier 1: must be answered to submit (marked *)
//   quick    shown in Quick mode (Tier 1 and 2 and the must-respond questions)
//   tier     2 = "Rather discuss this with you directly" is offered; 3 = "Rather not say" is offered
//   when     show only when the condition holds (see intake.js cond())
//   area     the Section F service this question belongs to; with detail: true it is a precision question,
//            hidden in Quick mode and when the family said "Just handle it" for that service
//   details  { option: 'label' | [fields] } a box that opens when that option is picked
//   fields   [{ k, label }] several short boxes in one question (name, relationship, phone …)
//   em       asked on the emergency path; everything else waits until the family circles back
//   noteOpen the "anything to add" note starts open (the questions where a yes/no hides the real answer)
//   nodk     no "I don't know" button
const DK_ = "I don't know";
const DISCUSS_ = 'Rather discuss this with you directly';
const RNS_ = 'Rather not say';
const EMERGENCY_ = 'This is an emergency, or it has already happened';

const q = (id, text, type, o) => Object.assign({ id, q: text, type }, o || {});
const ch = (id, text, opts, o) => q(id, text, 'choice', Object.assign({ opts }, o || {}));
const mu = (id, text, opts, o) => q(id, text, 'multi', Object.assign({ opts }, o || {}));
const tx = (id, text, o) => q(id, text, 'text', o);
const lt = (id, text, o) => q(id, text, 'text', Object.assign({ long: true }, o || {}));
const fl = (id, text, fields, o) => q(id, text, 'fields', Object.assign({ fields }, o || {}));
const f = (k, label, o) => Object.assign({ k, label }, o || {});
const NRP = [f('name', 'Name'), f('rel', 'Relationship'), f('phone', 'Phone', { tel: true })];
const NP = [f('name', 'Name'), f('phone', 'Phone', { tel: true })];
// conditions
const is = (id, ...v) => ({ q: id, is: v });
const has = (id, ...v) => ({ q: id, has: v });
const filled = id => ({ q: id, filled: true });
const all = (...c) => ({ all: c });
const any = (...c) => ({ any: c });
const not = c => ({ not: c });
const role = (...r) => ({ role: r });
const svc = (...k) => ({ svc: k });
const ages = (lo, hi) => ({ ages: [lo, hi] });

// ---- Section F: the services. Keys gate the questions that only matter when that help was asked for.
const SERVICES = [
  { g: 'Getting through the practical side', opts: [
    ['rides', 'Rides, parking, and getting to appointments'],
    ['calendar', 'Keeping the appointment calendar and making sure things get scheduled'],
    ['house', 'Getting the house ready before surgery'],
    ['equipment', 'Equipment and supplies — walker, shower chair, wound supplies'],
    ['pharmacy', 'Prescription pickups and pharmacy runs'],
    ['meals', 'Meals, groceries, and errands'],
    ['childcare', 'Childcare coverage'],
    ['pets', 'Pet care'],
    ['lodging', 'Lodging near the hospital for family traveling in']] },
  { g: 'A plan you can hold', opts: [
    ['roadmap', 'A written day-by-day roadmap for the whole recovery'],
    ['dates', 'Clear dates for when restrictions lift — driving, lifting, showering']] },
  { g: 'Paperwork and bills', opts: [
    ['records', 'Gathering medical records into one place'],
    ['bills', 'Tracking bills and catching billing errors'],
    ['auth', 'Chasing prior authorizations'],
    ['leave', 'FMLA, disability, or leave paperwork']] },
  { g: 'Making sense of it all', opts: [
    ['meds', 'Help keeping medications straight'],
    ['appts', 'Someone joining appointments to take notes'],
    ['questions', 'Help preparing questions before appointments'],
    ['symptoms', 'Help putting confusing symptoms into clear words for the care team']] },
  { g: 'Keeping everyone together', opts: [
    ['updates', "Family updates, so one person isn't the switchboard"],
    ['page', 'A private page for surgery day'],
    ['visits', 'Organizing who visits and when'],
    ['kids', 'Help explaining things to children'],
    ['coverage', "A coverage schedule, [[so {NAME} isn't alone when they shouldn't be|so you're not alone when you shouldn't be]]"]] },
  { g: 'The longer road', opts: [
    ['checkins', 'Check-ins through recovery'],
    ['scans', 'Support around follow-up scans'],
    ['answers', 'Straight answers on driving, work, and exercise — within the limits the doctor set'],
    ['caregiver', 'Support for the caregiver, not only the patient']] },
];
const SVC_BY_TEXT = {}; SERVICES.forEach(g => g.opts.forEach(([k, t]) => { SVC_BY_TEXT[t] = k; }));
const SVC_TEXT = {}; SERVICES.forEach(g => g.opts.forEach(([k, t]) => { SVC_TEXT[k] = t; }));
// The per-area depth question asked after each ticked service (Decide-as-I-go mode).
const DEPTH_OPTS = ["I'll tell you — it matters to me", "Just handle it, ask me if you're unsure", "Give me a couple of options and I'll pick"];
const JUST_HANDLE = DEPTH_OPTS[1];
// Services with precision questions behind them: only these get the depth question.
const DEPTH_AREAS = ['rides', 'house', 'equipment', 'pharmacy', 'meals', 'childcare', 'pets', 'lodging', 'appts', 'meds'];

const LIFT = { any: [has('I.3', 'No bending, lifting, or twisting'), { q: 'I.1', startsWith: 'Yes' }] };
const MOBILITY = { any: [has('I.3', 'No bending, lifting, or twisting', 'Dizziness or balance problems expected', 'Will wear a brace, collar, or helmet', 'Weakness in an arm or leg'), is('I.4', 'Uses a cane or walker', 'Uses a wheelchair', 'Already needs help with bathing or dressing'), is('I.5', 'Needs a hand from one person', 'Needs two people')] };

const INTAKE_STEPS_ = [
  // ---------------------------------------------------------------- Section 0
  { id: '0', title: "Who's filling this out", lead: 'Two quick questions about how you want to do this.', qs: [
    ch('0.1', "Who's filling this out?", ["I'm the person having surgery", "I'm a family member or friend", "We're doing it together"], { req: true, em: true, nodk: true, quick: true }),
    ch('0.1a', 'How would you like to do this?', ["Quick — just the essentials, we'll sort the details out when we talk", "Thorough — ask me everything, I'd rather get it right on paper", "Let me decide as I go — I'll go deep on the parts that matter to me"],
      { req: true, nodk: true, quick: true, why: "There's no right answer. Some people want to spell everything out; others would rather hand it over. Both work fine for us, and you can change your mind at any point." }),
    ch('0.2', "Is there someone who'll be helping you through this?", ['Yes', "Not really — I'm mostly on my own", 'Not sure yet'],
      { when: role('patient'), quick: true, details: { Yes: NRP } }),
    ch('0.3', 'May we talk with them directly about arrangements?', ['Yes, anything', 'Only certain things', "I'd rather you go through me"],
      { when: all(role('patient'), is('0.2', 'Yes')), details: { 'Only certain things': 'Which things?' } }),
    lt('0.4', "Is there anything you'd rather we didn't discuss with your family?", { when: role('patient'), tier: 3 }),
    ch('0.5', "Does {NAME} know you're filling this out?", ['Yes', 'Not yet'],
      { when: role('family'), quick: true, why: "If not yet: we'd just want to loop them in before we contact them directly." }),
    ch('0.6', 'When we need to reach someone, who should we start with?', ['Either of us', '{NAME}', 'The family member'], { when: role('together') }),
  ] },
  // ---------------------------------------------------------------- Section A
  { id: 'A', title: 'About {NAME}', lead: 'The basics we need before anything else.', catchAll: false, qs: [
    tx('A.name', "{NAME_CAP_S} legal name", { req: true, em: true, quick: true, ph: 'First, middle, last' }),
    tx('A.pref', 'Preferred name', { ph: 'What they like to be called' }),
    q('A.dob', 'Date of birth', 'date', { quick: true, dob: true, alts: ["I'd rather give it later"],
      why: "Hospitals and doctors' offices match medical records by name and birth date. If you'd rather give it later, or only if we end up requesting records, that's completely fine. We do not ask for a Social Security number and never will." }),
    tx('A.addr', 'Street address', { quick: true, ph: 'Street address', alts: [DISCUSS_] }),
    tx('A.city', 'City, state, ZIP', { quick: true, ph: 'Franklin, TN 37064' }),
    tx('A.phone', 'Best phone number for {NAME}', { req: true, quick: true, ph: '(615) 555-0100', why: 'A working number is one of the few things we cannot do without.' }),
    tx('A.home', 'Home phone', { ph: 'If there is one' }),
    tx('A.email', 'Email', { ph: 'name@example.com' }),
    ch('A.1', 'Preferred language', ['English', 'Other', 'An interpreter would help'], { quick: true, details: { Other: 'Which language?', 'An interpreter would help': 'Which language?' } }),
    ch('A.2', '{DOES} live alone?', ['Lives with others', 'Lives alone'], { req: true, quick: true, noteOpen: true,
      why: 'We need this one. Most procedures require someone to be with the patient the first night, so it changes what has to be arranged before surgery.' }),
    ch('A.2a', 'Is there someone who could stay the first night or two?', ['Yes', 'No', "Maybe, I'd need to ask"], { when: is('A.2', 'Lives alone'), quick: true, details: { Yes: 'Who?' },
      why: "Most procedures require someone present for the first stretch. If there's nobody, that's usually the first thing we solve — and it's very solvable. Don't worry about it before we talk." }),
  ] },
  // ---------------------------------------------------------------- Section B
  { id: 'B', title: 'About you', lead: 'The person filling this out.', when: not(role('patient')), catchAll: false, qs: [
    tx('B.name', 'Your full name', { quick: true }),
    tx('B.rel', 'Your relationship to {NAME}', { quick: true, ph: 'Daughter, husband, friend' }),
    tx('B.phone', 'Your mobile phone', { quick: true, ph: '(615) 555-0100' }),
    tx('B.email', 'Your email', { quick: true }),
    tx('B.addr', 'Your address, if different from {NAME_S}'),
    ch('B.1', 'Best way to reach you', ['Phone call', 'Text', 'Email', "Whatever's fastest"], { quick: true, nodk: true }),
  ] },
  // ---------------------------------------------------------------- Section C
  { id: 'C', title: 'Key contacts', lead: "Sometimes these are all one person. Sometimes they're five different people. Either is normal.", qs: [
    ch('C.1', 'Day-to-day contact for our team', ['Same as the person filling this out', 'Someone else'], { quick: true, nodk: true, details: { 'Someone else': NRP } }),
    ch('C.2', 'Primary caregiver — the person doing most of the hands-on helping', ['Same as above', 'Someone else', "We haven't figured this out yet"],
      { quick: true, tier: 2, noteOpen: true, details: { 'Someone else': NRP }, why: 'Anything we should know about their situation? — how much they can realistically take on, what else they’re juggling.' }),
    tx('C.2a', 'Is there someone it would probably fall to?', { when: is('C.2', "We haven't figured this out yet") }),
    tx('C.2b', "Has anyone offered that you haven't asked yet?", { when: is('C.2', "We haven't figured this out yet") }),
    ch('C.2c', "If {HELPER} gets sick, has to travel, or simply hits a wall — who's second?", ['Someone', "There isn't anyone", "Haven't thought about it"],
      { quick: true, details: { Someone: NRP }, why: 'Recovery runs longer than anyone plans for, and the person carrying it usually needs a break before they’d ever ask for one. Naming a backup now costs nothing and saves a scramble later.' }),
    ch('C.3', "Medical decision-maker — if {NAME} couldn't speak for [[themselves|yourself]]", ['Someone named', 'Same as above', "There's a health care proxy or power of attorney document", 'No document that we know of'],
      { tier: 2, details: { 'Someone named': NRP } }),
    ch('C.3a', 'Does the hospital actually have a copy on file?', ["Yes, we've given it to them", 'No', 'Not sure'], { when: is('C.3', "There's a health care proxy or power of attorney document") }),
    ch('C.3b', 'Do you know where the original is?', ['Yes', 'Somewhere at home', 'With a lawyer', 'Not sure'], { when: is('C.3', "There's a health care proxy or power of attorney document"),
      why: "A directive in a drawer at home isn't much use to the hospital. Getting a copy into the chart is simple paperwork, and we can handle it." }),
    ch('C.3c', 'Would you like information on getting one in place before surgery?', ['Yes', "We've talked about it", 'No', 'Rather discuss in person'],
      { when: is('C.3', 'No document that we know of', DK_), why: "We can point you to the right forms for your state. The document itself is a legal matter, so we'd steer you to a lawyer or the hospital's own resources rather than advising you ourselves." }),
    fl('C.4', 'Emergency contact', NRP, { quick: true }),
    fl('C.5', 'After-hours contact', [f('name', 'Name'), f('phone', 'Phone', { tel: true }), f('bname', 'Backup name'), f('bphone', 'Backup phone', { tel: true })], { req: true, quick: true }),
    ch('C.6', 'Main contact with the surgical team — the one person the doctors and nurses should call', ['Same as the day-to-day contact', 'Someone else', "Nobody's been designated — several of us are calling"],
      { quick: true, details: { 'Someone else': NP }, why: 'When several people call the office, messages get crossed. One named person keeps the information clean.' }),
    lt('C.7', 'Anyone else closely involved we should know about?'),
  ] },
  // ---------------------------------------------------------------- Section D
  { id: 'D', title: 'Contacting {NAME}', when: not(role('patient')), qs: [
    ch('D.1', 'Does {NAME} know your family is working with us?', ["Yes, and they're on board", "Yes, but they're unsure about it", 'Not yet — I wanted to look into it first', "They aren't able to take part in that decision right now", DISCUSS_], { quick: true, nodk: true }),
    ch('D.2', 'May we contact {NAME} directly?', ['Yes, for anything', 'Only for certain things', 'No, please go through me', "Let's decide together"], { when: role('family'), quick: true, nodk: true, details: { 'Only for certain things': 'Which things?' } }),
    ch('D.3', 'Best way to reach them', ['Call', 'Text', 'Email', 'Through me']),
    lt('D.4', 'Anything about how {NAME} prefers to be communicated with?', { ph: 'Prefers directness, gets overwhelmed by detail, hard of hearing, better in the mornings.' }),
    lt('D.5', "If we asked {NAME} directly, what would they say they're most worried about?", { alts: ["I'm not sure", "We haven't talked about it"],
      why: "You're the one filling this out, so we're only hearing your view of things. This helps us hear a bit of theirs." }),
    lt('D.6', 'Is there anything {NAME} is adamant about — something they want to keep doing themselves, or don’t want help with?', { alts: ['Not that I know of'] }),
  ] },
  // ---------------------------------------------------------------- Section F (asked before E, because it gates E)
  { id: 'F', title: 'What would help most', lead: "We don't sell packages or tiers. We start wherever your family needs us and grow from there. Tick anything useful — you're not committing to it, and you can add or drop things anytime.", qs: [
    q('F', 'What would help?', 'multi', { groups: SERVICES.map(g => ({ label: g.g, opts: g.opts.map(o => o[1]) })), opts: [].concat(...SERVICES.map(g => g.opts.map(o => o[1]))), nodk: true, quick: true }),
    ...DEPTH_AREAS.map(k => ch('F.d.' + k, 'You ticked “' + SVC_TEXT[k].split(' — ')[0].split(',')[0] + '.” Would you like to tell us how you like it done, or should we handle it and check with you?', DEPTH_OPTS,
      { when: all(svc(k), { mode: ['decide'] }), nodk: true, depth: k })),
    lt('F.1', 'If you could only pick one thing for us to take off your plate, what would it be?', { req: true, em: true, quick: true }),
  ] },
  // ---------------------------------------------------------------- Section E
  { id: 'E', title: 'Insurance', when: svc('records', 'bills', 'auth'),
    lead: "We only ask for this because you've asked us to help with bills, records, or authorizations. Nobody can work on those without it. If you'd rather hand it over in person, tell us and we'll skip ahead.", qs: [
    tx('E.carrier', 'Insurance carrier', { quick: true, alts: ["We'll hand it over in person"] }),
    ch('E.type', 'Plan type', ['Employer', 'Medicare', 'Medicaid', 'Marketplace', 'VA', 'Other', 'Not sure'], { quick: true, nodk: true }),
    tx('E.member', 'Member ID', { alts: ["We'll hand it over in person"] }),
    tx('E.holder', 'Policy holder, if not {NAME}'),
    tx('E.second', 'Secondary insurance'),
    ch('E.0', "Have you ever used the plan's ride benefit to get to appointments?", ['Yes', 'No', "Didn't know there was one"], { when: is('E.type', 'Medicaid') }),
    ch('E.0a', 'Is the surgery being done at a VA facility, or in the community?', ['VA facility', 'Community care', 'Not sure'], { when: is('E.type', 'VA') }),
    ch('E.0b', 'Has anyone mentioned travel reimbursement for appointments?', ["Yes, we use it", "Heard of it, haven't used it", 'Never heard of it'], { when: is('E.type', 'VA') }),
    ch('E.0c', '{HELPER_IS} enrolled in the VA Caregiver Support Program?', ['Yes', 'Applied', 'No', 'Never heard of it'], { when: is('E.type', 'VA') }),
    ch('E.0d', 'Do you have a VA social worker or patient advocate?', ['Yes', 'No', 'Not sure'], { when: is('E.type', 'VA'), details: { Yes: 'Name' },
      why: "VA benefits around travel and caregiver support are underused. We'll find out what applies to you." }),
    ch('E.1', 'Have bills or insurance statements started arriving?', ['Not yet', 'A few', "Quite a lot, and it's confusing", "There's one we're already disputing"]),
    ch('E.2', 'Is anything currently waiting on insurance approval?', ['No', 'Yes', 'Something was denied', 'Not sure'], { details: { Yes: 'What?' } }),
  ] },
  // ---------------------------------------------------------------- Section G
  { id: 'G', title: 'The diagnosis and the surgery', lead: "In your own words is fine. We never interpret this or advise on it — that is your care team's work.", qs: [
    lt('G.1', '[[What is {NAME} dealing with?|What are you dealing with?]]', { req: true, em: true, quick: true, tier: 2, ph: "Whatever the doctors have told you, however you'd explain it to a friend.", alts: ["We're still waiting to find out", DISCUSS_] }),
    tx('G.2', 'When did you find out?', { ph: 'A date, or roughly', alts: ['Still in the middle of finding out'], why: 'A family three days into this needs something very different from a family three months in.' }),
    ch('G.3', "Is this a first occurrence, or something that's come back or progressed?", ['First time', "It's come back", "It's progressed or changed", 'Not sure', 'Rather discuss in person']),
    lt('G.4', 'What surgery is planned?', { req: true, quick: true, alts: ["We don't have a name for it yet"] }),
    ch('G.4a', 'Did they mention whether it’s an open operation or a smaller, minimally invasive one?', ['Open', 'Minimally invasive or endoscopic', 'Both / not sure', 'Nobody said'],
      { why: 'The same operation done two different ways can mean one night in the hospital or five.' }),
    mu('G.5', 'Is anything else part of the treatment plan?', ['Radiation', 'Chemotherapy or infusions', 'Physical or occupational therapy', 'Another surgery later', 'Ongoing scans or monitoring', 'Just this surgery', 'Not sure yet']),
    q('G.6', 'Surgery date', 'date', { req: true, em: true, quick: true, alts: ['Not scheduled yet', EMERGENCY_] }),
    ch('G.6a', 'Where are things right now?', ['Still in surgery', 'In the ICU', 'On a regular floor', 'Discharge is being discussed', 'Already home'], { when: is('G.6', EMERGENCY_), em: true, quick: true }),
    lt('G.6b', "What's the most pressing thing in the next 48 hours?", { when: is('G.6', EMERGENCY_), em: true, quick: true }),
    tx('G.6e', 'Who is with {NAME} right now?', { when: is('G.6', EMERGENCY_), em: true, quick: true }),
    fl('G.6f', 'Who should we call first?', NP, { when: is('G.6', EMERGENCY_), em: true, quick: true }),
    ch('G.6c', 'Has this surgery been rescheduled before?', ['No', 'Yes, once', 'Yes, more than once'], { when: not(is('G.6', EMERGENCY_)) }),
    ch('G.6d', 'If the date moves — which does happen — would you want everything we’ve arranged held, or cancelled?', ["Hold it, we'll just shift the dates", 'Cancel and rebuild when we know more', 'Depends how far it moves', "Hadn't thought about that"],
      { when: not(is('G.6', EMERGENCY_)), why: 'Dates move more often than families expect. Knowing your preference now saves a scramble later.' }),
    q('G.7', 'Which hospital is the surgery at?', 'select', { req: true, em: true, quick: true, optsFrom: 'hospitals', ph: 'Choose the hospital',
      alts: ['Somewhere else', "We don't know yet"], detailOn: 'Somewhere else', detailLabel: 'Which hospital, and which city?',
      why: 'For the hospitals we know, this puts the campus map, parking, the entrance to use and help nearby on your plan.' }),
    tx('G.7s', 'Health system', { ph: 'Vanderbilt, HCA, Ascension…' }),
    tx('G.7c', 'City'),
    tx('G.8', 'Surgeon or practice'),
    ch('G.9', 'Expected hospital stay', ['Home the same day', 'One night', '2–3 nights', '4–7 nights', 'More than a week', DK_], { req: true, quick: true, nodk: true }),
    ch('G.9a', 'On the day of surgery, who is the specific adult picking {NAME} up?', ['Someone named', "We haven't sorted this out"],
      { when: is('G.9', 'Home the same day', 'One night'), quick: true, details: { 'Someone named': NP },
        why: "The hospital won't discharge to a taxi or rideshare on its own — they need a named adult. This is usually the first thing we solve." }),
    ch('G.9b', 'Can that person stay overnight afterward?', ['Yes', 'No', 'Not sure'], { when: is('G.9', 'Home the same day', 'One night'), quick: true }),
    lt('G.9c', "That's several days where the household runs without {HELPER}. Which days worry you most?", { when: is('G.9', '4–7 nights', 'More than a week') }),
    ch('G.10', 'After the hospital, {IS} expected to go straight home?', ['Straight home', 'To rehab or a nursing facility first', 'Not sure yet', DK_],
      { req: true, quick: true, nodk: true, noteOpen: true, why: 'This matters more than almost anything else on this form.' }),
    ch('G.10a', 'Do you know which facility?', ['Known', 'Still being decided'], { when: is('G.10', 'To rehab or a nursing facility first'), details: { Known: 'Which one?' } }),
    ch('G.10b', 'How far is it from home?', ['Close by', 'A drive', 'Far enough that visiting will be hard', "Don't know"], { when: is('G.10', 'To rehab or a nursing facility first') }),
    ch('G.10c', 'Want help getting the house ready for when [[they do|you do]] come home, even though that’s further out?', ['Yes', 'Later', 'No'], { when: is('G.10', 'To rehab or a nursing facility first') }),
    ch('G.11', 'How many different doctors or facilities are involved?', ['Just the one', '2–3', '4 or more', 'Not sure'],
      { when: svc('records', 'bills', 'auth'), details: { '2–3': 'List them if you can', '4 or more': 'List them if you can' }, why: 'Each one usually needs its own signed release before they’ll send records to us.' }),
    ch('G.12', 'Is there an online patient portal — MyChart or similar?', ['Yes, and we can log in', 'Yes, but never set up', 'No', 'Not sure'],
      { when: svc('records', 'bills', 'auth'), why: "Please never send us passwords. We'll show you how to share access properly." }),
  ] },
  // ---------------------------------------------------------------- Section H
  { id: 'H', title: 'Appointments and dates', qs: [
    fl('H.1', "What's already on the calendar?", [f('preop', 'Pre-op'), f('follow', 'First follow-up'), f('therapy', 'Therapy starting'), f('scans', 'Scans or imaging')], { alts: ['Nothing scheduled yet', DK_] }),
    ch('H.2', 'Please attach or photograph any instruction sheets you’ve been given.', ['Attached', "Haven't received any yet", "I'll bring them to the meeting"],
      { quick: true, upload: true, why: 'This is the single most helpful thing you can give us. Those papers are the real rules. Add them under Documents.' }),
    ch('H.3', 'Would you like someone from our team joining appointments to take notes?', ['Yes', 'No', 'Maybe, for the important ones'], { when: svc('appts') }),
    mu('H.4', 'Which ones matter most?', ['Pre-op', 'First follow-up', 'Any where results are discussed', 'Scan and imaging reviews', 'All of them', 'Decide as we go'], { when: all(svc('appts'), is('H.3', 'Yes', 'Maybe, for the important ones')), area: 'appts', detail: true }),
    ch('H.4a', 'Are those one-offs or recurring?', ['One-off', 'Recurring'], { when: all(svc('appts'), is('H.3', 'Yes', 'Maybe, for the important ones')), area: 'appts', detail: true }),
    tx('H.4b', 'Does anyone else usually come along?', { when: all(svc('appts'), is('H.3', 'Yes', 'Maybe, for the important ones')), area: 'appts', detail: true }),
    ch('H.4c', 'Questions already piling up that we should start a list with?', ['Yes', 'Not yet'], { when: all(svc('appts'), is('H.3', 'Yes', 'Maybe, for the important ones')), area: 'appts', detail: true }),
    ch('H.5', 'In person, by video, or both?', ['In person', 'Video', 'Both', 'Not sure'], { when: all(svc('appts'), is('H.3', 'Yes', 'Maybe, for the important ones')), area: 'appts', detail: true }),
    ch('H.6', 'Recording: we can record so you get an accurate summary — only if you want it, and only if the clinician agrees in the room.', ['Yes, when the provider allows', 'No, written notes only', 'Decide each time'],
      { when: all(svc('appts'), is('H.3', 'Yes', 'Maybe, for the important ones')), why: "Some providers don't permit it. We always ask first." }),
    ch('H.7', 'Would it help to have your questions written out before appointments?', ['Yes', 'No', 'Sometimes'], { when: svc('appts') }),
    ch('H.8', "Is it hard to find the words for what's going on — describing symptoms or changes to the care team?", ['No', 'Sometimes', "Yes, that's been difficult"],
      { when: svc('appts'), why: "We help you say it plainly. We don't interpret what it means — that's your care team's job." }),
  ] },
  // ---------------------------------------------------------------- Section H2
  { id: 'H2', title: 'Surgery day readiness', when: not(is('G.6', EMERGENCY_)),
    lead: "A surgery getting cancelled or postponed on the day costs a family a great deal. Most cancellations come down to something simple that nobody confirmed. We're only checking that instructions were given and understood — we don't give medical instructions and we don't change any your team has given you.", qs: [
    ch('H2.1', 'Have you been given fasting instructions — when to stop eating and drinking?', ['Yes', "Told, but we don't remember the times", 'Not yet', DK_],
      { head: 'Before the day', quick: true, tier: 2, nodk: true, details: { Yes: [f('eat', 'Stop eating at'), f('drink', 'Stop drinking at')] } }),
    ch('H2.2', 'Does everyone in the house know those times?', ['Yes', 'Not really', "We'll need reminders"],
      { why: 'Eating or drinking when you shouldn’t is the single most common reason a surgery gets cancelled on the day. We’ll set reminders for you and for anyone else at home who might hand over a coffee.' }),
    ch('H2.3', 'Has anyone told you to stop any medications before surgery?', ['Yes', "Yes, but we're not clear on the timing", 'No', DK_],
      { quick: true, tier: 2, nodk: true, details: { Yes: 'When do they stop?' }, why: "If there's a stop date, we'll put it on the calendar and remind you. What to stop and when is entirely your care team's call — we only track the dates they gave you." }),
    ch('H2.4', 'Have you been given any requirements about smoking, vaping, or alcohol before surgery?', ['Yes', 'No', "Doesn't apply", 'Rather discuss in person'], { details: { Yes: 'What, and by when?' } }),
    mu('H2.5', 'Are there pre-op tests, labs, or clearances that need doing?', ['Bloodwork', 'Imaging or scans', 'Heart or cardiac clearance', 'Clearance from another doctor', 'COVID or other testing', 'None that we know of', DK_], { quick: true, nodk: true }),
    ch('H2.6', 'Have they all been done?', ['All done', 'Some done', 'None yet', 'Not sure'], { when: not(is('H2.5', 'None that we know of')) }),
    ch('H2.7', 'Has anyone confirmed the results are back and cleared?', ['Yes', 'No', "Hadn't thought to check"],
      { when: not(is('H2.5', 'None that we know of')), why: "A test taken isn't the same as a test cleared. Missing results are a frequent cause of last-minute postponement, and chasing them is exactly the kind of thing we handle." }),
    ch('H2.8', 'Is insurance authorization approved for the surgery?', ['Yes, confirmed', 'Submitted, waiting', "Don't know", "Doesn't apply"], { quick: true, nodk: true }),
    ch('H2.9', 'Has anyone told you what to do if {NAME} [[gets|get]] sick before surgery?', ['Yes', 'No', DK_], { nodk: true }),
    ch('H2.10', 'Is anyone in the household unwell right now — a cold, cough, fever, stomach bug?', ['No', 'Yes', "Someone's just getting over something"], { quick: true }),
    mu('H2.11', 'Anything else brewing that’s been mentioned as a possible delay?', ['Dental work or a tooth problem', 'A skin infection, rash, or open wound', 'An infection being treated', 'Nothing we know of', 'Something else'], { details: { 'Something else': 'What?' } }),
    ch('H2.12', '{HAS} had general anesthesia before?', ['Yes, several times', 'Once or twice', 'Never', 'Not sure'],
      { head: 'Anesthesia history', tier: 2, why: "Please tell your anesthesia team all of this directly. We're asking so we can plan your day — how long the wait might be, who should be there when {NAME} [[wakes|wake]] up, whether the ride home needs to be different. We do not pass medical history to your care team for you." }),
    mu('H2.12a', 'How did [[they|you]] do with it?', ['Fine, no trouble', 'Nausea or vomiting afterward', 'Took a long time to wake up', 'Confused or agitated on waking', 'Bad sore throat afterward', 'Shivering or very cold', 'Pain was hard to get on top of', 'Something else'],
      { when: is('H2.12', 'Yes, several times', 'Once or twice'), details: { 'Something else': 'What happened?' } }),
    ch('H2.12b', 'Roughly how long until [[they|you]] felt like [[themselves|yourself]]?', ['A few hours', 'Rest of the day', 'A day or two', 'Longer'], { when: is('H2.12', 'Yes, several times', 'Once or twice') }),
    ch('H2.12c', 'Did any of it change when [[they were|you were]] allowed to go home?', ['Yes, they kept us longer', 'No', 'Not sure'], { when: is('H2.12', 'Yes, several times', 'Once or twice') }),
    ch('H2.13', '{DOES} get motion sickness — cars, boats, planes?', ['Yes', 'Sometimes', 'No'], { why: 'This tends to predict how someone handles anesthesia, so it helps us plan the ride home and who should be with [[them|you]].' }),
    ch('H2.14', 'Has anyone in the family ever had a serious reaction to anesthesia?', ['Yes', 'No', 'Not sure', DISCUSS_], { tier: 2, nodk: true }),
    tx('H2.14a', 'Do you know what happened?', { when: is('H2.14', 'Yes'), why: 'Please make sure the anesthesia team knows. Some reactions run in families and they’ll want to plan for it.' }),
    ch('H2.15', 'Do you know what time to arrive?', ['Yes', 'We have one time but not the other', 'Not yet'],
      { head: 'The day itself', quick: true, details: { Yes: [f('report', 'Report time'), f('surgery', 'Surgery time')] }, why: "These are usually different, often by two hours or more. We'll confirm both and build the morning backward from the report time." }),
    ch('H2.16', 'Do you know which building and entrance?', ['Yes', 'No', "It's a big campus and we're not sure"]),
    ch('H2.17', 'Has anyone told you what to leave at home or remove?', ['Yes', 'No', 'Not sure']),
    mu('H2.18', 'Is any of this going to be a problem?', ["Jewelry or piercings that don't come out easily", 'Contact lenses — and no glasses as a backup', 'Nail polish or gel nails', 'Hearing aids or a device [[they rely|you rely]] on', 'Dentures or a partial', 'None of these']),
    ch('H2.19', 'Will an interpreter be needed on the day?', ['No', 'Yes', "Yes, and we don't know if one's booked"], { details: { Yes: 'Language', "Yes, and we don't know if one's booked": 'Language' } }),
    fl('H2.20', "Who's coming with {NAME}, and who's staying through the surgery?", [f('coming', 'Coming'), f('staying', 'Staying in the waiting area')], { quick: true, alts: ['Nobody can stay'] }),
    ch('H2.21', 'How long are you expecting the day to be?', ["We've been told roughly", 'No idea'],
      { details: { "We've been told roughly": 'How long?' }, why: "Waiting-room days run longer than families expect. We'll tell you what to bring and make sure whoever's waiting gets fed." }),
    lt('H2.22', 'Anything else about the day that’s worrying you?'),
  ] },
  // ---------------------------------------------------------------- Section I
  { id: 'I', title: 'What {NAME} will be able to do', lead: "This is about what {NAME} can physically manage day to day, so we know what to arrange. We're asking what the care team told you — not for your assessment, and not so we can offer ours.", qs: [
    ch('I.1', 'Has anyone mentioned a weight limit — something like “nothing heavier than a gallon of milk”?', ['Yes', "They mentioned one but I don't remember", 'No limit mentioned', DK_],
      { quick: true, tier: 2, nodk: true, details: { Yes: 'The limit is' } }),
    ch('I.2', 'Has anyone said how long before {NAME} can drive?', ['Yes', 'No', DK_], { quick: true, tier: 2, nodk: true, details: { Yes: 'How long?' } }),
    mu('I.3', 'Were any of these mentioned?', ['No bending, lifting, or twisting', 'Needs to sleep propped up, head elevated', 'Will wear a brace, collar, or helmet', "Can't get the incision or dressing wet", 'No nose-blowing, no straws, no bending over', 'Dizziness or balance problems expected', 'Weakness in an arm or leg', 'Trouble with speech or finding words', 'Trouble swallowing, or changes to what [[they|you]] can eat', 'Vision or hearing changes', 'Something about seizures and driving', 'None of these', DK_],
      { quick: true, tier: 2, nodk: true, why: "Tick anything the care team has raised as a possibility. We're not asking you to predict — just to tell us what you've been warned about." }),
    tx('I.3a', 'For no bending, lifting, or twisting — did they give a time frame?', { when: has('I.3', 'No bending, lifting, or twisting'), ph: 'For example: 6 weeks', alts: ['Nobody said'] }),
    ch('I.3b', 'No nose-blowing, straws or bending usually runs about four weeks. Is there anyone small at home who’d normally get picked up?', ['Yes', 'No'], { when: has('I.3', 'No nose-blowing, no straws, no bending over') }),
    tx('I.3c', "Who'll handle anything involving bending — pet bowls, laundry, low cupboards?", { when: has('I.3', 'No nose-blowing, no straws, no bending over') }),
    ch('I.3d', 'Are there stairs [[they’d|you’d]] need to use daily?', ['Yes', 'No'], { when: has('I.3', 'Dizziness or balance problems expected') }),
    ch('I.3e', 'Throw rugs or loose cords in the main walking paths?', ['Yes', 'No', 'Not sure'], { when: has('I.3', 'Dizziness or balance problems expected'), area: 'house', detail: true }),
    ch('I.3f', 'Is there a pet that gets underfoot?', ['Yes', 'No'], { when: has('I.3', 'Dizziness or balance problems expected') }),
    tx('I.3g', 'The brace, collar, or helmet — for how long?', { when: has('I.3', 'Will wear a brace, collar, or helmet'), alts: ['Nobody said'] }),
    ch('I.3h', 'Needed for sleeping?', ['Yes', 'No', "Don't know"], { when: has('I.3', 'Will wear a brace, collar, or helmet'), nodk: true }),
    ch('I.3i', 'Needed for driving?', ['Yes', 'No', "Don't know"], { when: has('I.3', 'Will wear a brace, collar, or helmet'), nodk: true }),
    ch('I.3j', 'Will [[they|you]] need help washing [[their|your]] hair?', ['Yes', 'No', "Don't know"], { when: has('I.3', 'Will wear a brace, collar, or helmet'), nodk: true }),
    ch('I.3k', 'Is there clothing that fits over it — loose shirts that button?', ['Yes', 'No', "Hadn't thought about it"], { when: has('I.3', 'Will wear a brace, collar, or helmet') }),
    ch('I.3l', 'Is there someone who can help with bathing?', ['Yes', 'No'], { when: has('I.3', 'Will wear a brace, collar, or helmet') }),
    tx('I.3m', 'Seizures and driving: did they say how long before driving is allowed?', { when: has('I.3', 'Something about seizures and driving'), alts: ['Nobody said'] }),
    tx('I.3n', 'Which state [[does {NAME}|do you]] live in?', { when: has('I.3', 'Something about seizures and driving'),
      why: "Driving rules after seizures are set by state law and can run several months. We'll find out exactly what applies where you live, and plan transport for the long version meanwhile." }),
    ch('I.3o', 'Has the care team given guidance on food textures or thickened liquids?', ['Yes', 'Not yet'], { when: has('I.3', 'Trouble swallowing, or changes to what [[they|you]] can eat'),
      why: "We'll follow whatever they've told you exactly. We arrange the food; we don't make those calls." }),
    ch('I.3p', 'Weakness — which side?', ['Left', 'Right', 'Both', 'Not sure'], { when: has('I.3', 'Weakness in an arm or leg') }),
    ch('I.3q', 'Would help getting in and out of a car or bed be useful?', ['Yes', 'No'], { when: has('I.3', 'Weakness in an arm or leg') }),
    ch('I.3r', 'Would it help if we communicated mainly through you rather than directly with {NAME}?', ['Yes', 'No', 'Some of both'], { when: all(has('I.3', 'Trouble with speech or finding words'), not(role('patient'))) }),
    ch('I.3s', 'What [[do they|do you]] sleep on now?', ['Regular bed', 'Adjustable bed', 'Recliner', 'Sofa'], { when: has('I.3', 'Needs to sleep propped up, head elevated') }),
    ch('I.3t', 'Is there a recliner in the house?', ['Yes', 'No'], { when: has('I.3', 'Needs to sleep propped up, head elevated') }),
    ch('I.3u', 'Which floor is the bed on?', ['Main', 'Upstairs', 'Downstairs'], { when: has('I.3', 'Needs to sleep propped up, head elevated') }),
    ch('I.4', 'Before this surgery, how {WAS} getting around?', ['Fully independent', 'Steady but slow', 'Uses a cane or walker', 'Uses a wheelchair', 'Already needs help with bathing or dressing'], { req: true, quick: true }),
    mu('I.4a', 'Would a walker need to get through any of these?', ['Bathroom door', 'Bedroom door', 'A hallway with a turn', 'None'], { when: is('I.4', 'Uses a cane or walker', 'Uses a wheelchair'), area: 'house', detail: true }),
    ch('I.4b', 'Any doorways noticeably narrow — the kind you turn sideways for?', ['Yes', 'No', 'Not sure'], { when: is('I.4', 'Uses a cane or walker', 'Uses a wheelchair'),
      why: 'A walker needs about thirty inches of clear width; older bathroom doors are often twenty-four. The fix is cheap if we know in advance.' }),
    ch('I.4c', 'A threshold or lip between rooms where flooring changes?', ['Yes', 'No'], { when: is('I.4', 'Uses a cane or walker', 'Uses a wheelchair'), area: 'house', detail: true }),
    ch('I.5', 'Can {NAME} get out of a chair and move to another room on [[their|your]] own?', ['Yes, no help', 'Needs a hand from one person', 'Needs two people', DK_], { req: true, quick: true, nodk: true, noteOpen: true }),
    ch('I.6', 'Is there anything about memory or confusion we should plan around?', ['No', 'Sometimes', 'Yes, regularly', 'Rather discuss in person'], { quick: true, why: 'It changes whether someone needs to be nearby or continuously present.' }),
  ] },
  // ---------------------------------------------------------------- Section J
  { id: 'J', title: 'Medications', lead: "We're asking about the shape of the schedule, not what's in it. We don't need medication names on this form.", qs: [
    ch('J.1', 'Would you like help keeping medications organized after surgery?', ['Yes', "No, we've got that covered", "Maybe — let's talk"], { quick: true }),
    ch('J.2', 'Who usually manages medications?', ['[[{NAME}|Me]]', '{HELPER}', 'Shared', "Nobody's sure yet"], { when: all(is('J.1', 'Yes', "Maybe — let's talk"), svc('meds', 'pharmacy')) }),
    ch('J.3', 'Has medication timing been difficult before?', ['No', 'Sometimes', 'Yes'], { when: all(is('J.1', 'Yes', "Maybe — let's talk"), svc('meds', 'pharmacy')) }),
    ch('J.4', 'Would you like us handling prescription pickups?', ['Yes', 'No'], { when: all(is('J.1', 'Yes', "Maybe — let's talk"), svc('meds', 'pharmacy')), details: { Yes: [f('name', 'Pharmacy'), f('where', 'Location')] } }),
    ch('J.4a', 'Chain or local independent?', ['Chain', 'Independent', 'Hospital', 'Mail order'], { when: all(is('J.4', 'Yes'), svc('meds', 'pharmacy')), area: 'pharmacy', detail: true }),
    ch('J.4b', 'Do they deliver?', ['Yes', 'No', "Don't know"], { when: all(is('J.4', 'Yes'), svc('meds', 'pharmacy')), nodk: true }),
    ch('J.4c', 'Open weekends?', ['Yes', 'No', "Don't know"], { when: all(is('J.4', 'Yes'), svc('meds', 'pharmacy')), nodk: true,
      why: "Discharge often lands Friday afternoon. A pharmacy that closes Saturday noon and doesn't deliver turns a routine pickup into a scramble." }),
    ch('J.5', 'Roughly how many medications are we talking about?', ['A few (1–3)', 'A handful (4–7)', 'Quite a lot (8+)', 'Not sure yet'], { when: all(is('J.1', 'Yes', "Maybe — let's talk"), svc('meds', 'pharmacy')) }),
    mu('J.6', 'Anything tricky about the schedule?', ['Doses at odd hours, including overnight', 'Some with food, some away from food', 'Something needs refrigeration', "An injection or something that isn't just a pill", 'Nothing unusual', 'Not sure yet'],
      { when: all(is('J.1', 'Yes', "Maybe — let's talk"), svc('meds', 'pharmacy')), area: 'meds', detail: true }),
  ] },
  // ---------------------------------------------------------------- Section K
  { id: 'K', title: 'The home', when: not(is('G.10', 'To rehab or a nursing facility first')), qs: [
    ch('K.1', 'Are there steps to get in the front door?', ['No steps at any entrance', 'Yes', 'Yes, but another door has no steps'], { req: true, quick: true }),
    tx('K.1a', 'How many steps?', { when: is('K.1', 'Yes') }),
    ch('K.1b', 'Handrail?', ['Both sides', 'One side', 'None'], { when: is('K.1', 'Yes') }),
    ch('K.1c', 'Flat landing at the top, or does the door open right at the step?', ['Landing', 'Right at the step'], { when: is('K.1', 'Yes'), area: 'house', detail: true }),
    ch('K.1d', 'Walkway width up to the door?', ['Two people side by side', 'Narrower'], { when: is('K.1', 'Yes'), area: 'house', detail: true }),
    ch('K.1e', 'How far from where a car parks to the front door?', ['A few steps', 'Across a yard', 'A real walk'], { when: is('K.1', 'Yes'),
      why: "A portable ramp needs about twelve feet of run per foot of rise — three steps is roughly eighteen feet of ramp. If there's no landing or no room, a ramp isn't the answer and we'll plan differently." }),
    ch('K.2', 'Is the home one level or more?', ['One level', 'Two or more'], { quick: true }),
    ch('K.3', 'Which floor is the bedroom {NAME} [[uses|use]]?', ['Main', 'Upstairs', 'Downstairs'], { when: is('K.2', 'Two or more'), quick: true }),
    ch('K.3x', 'And the full bathroom?', ['Main', 'Upstairs', 'Downstairs', "There's only one full bathroom"], { when: is('K.2', 'Two or more'), quick: true }),
    tx('K.3a', 'How many flights?', { when: is('K.2', 'Two or more') }),
    ch('K.3b', 'Straight run, or do they turn?', ['Straight', 'One turn', 'Winding'], { when: is('K.2', 'Two or more'), area: 'house', detail: true, why: 'Straight versus turning determines whether a stairlift is even an option.' }),
    ch('K.3c', 'Handrail on the stairs?', ['Both sides', 'One side', 'None'], { when: is('K.2', 'Two or more') }),
    ch('K.3d', 'Anywhere on the main floor [[they|you]] could sleep temporarily?', ['Yes', 'No', "Hadn't thought about it"], { when: all(is('K.2', 'Two or more'), { differentFloors: true }, MOBILITY), quick: true }),
    ch('K.3e', 'Is there a bath on that floor?', ['Full', 'Half only', 'None'], { when: all(is('K.2', 'Two or more'), { differentFloors: true }, MOBILITY), quick: true }),
    ch('K.4', 'The shower or bath {NAME} would use', ['Walk-in shower, no step over', 'Shower over a bathtub', 'Tub only', 'Walk-in with a small lip'], { quick: true }),
    ch('K.4a', 'Shower door, or a curtain?', ['Sliding glass door', 'Hinged door', 'Curtain', 'No enclosure'], { when: is('K.4', 'Shower over a bathtub', 'Tub only'),
      why: 'A sliding glass door makes a transfer bench unusable — the bench has to extend outside the tub and the track is in the way.' }),
    ch('K.4b', 'Roughly how high is the tub wall?', ['Knee height or lower', 'Above the knee', 'Not sure'], { when: is('K.4', 'Shower over a bathtub', 'Tub only'), area: 'house', detail: true }),
    ch('K.4c', 'Space beside the tub for someone to stand and help?', ['Yes', "It's tight", 'No'], { when: is('K.4', 'Shower over a bathtub', 'Tub only'), area: 'house', detail: true }),
    ch('K.4d', 'Bathroom walls — tile or drywall?', ['Tile', 'Drywall', 'Not sure'], { when: is('K.4', 'Shower over a bathtub', 'Tub only'), area: 'house', detail: true, why: 'Tile versus drywall determines how grab bars anchor.' }),
    mu('K.5', "What's already installed?", ['Grab bars in the bathroom', 'Handrails on the stairs — one side', 'Handrails on the stairs — both sides', 'Raised toilet seat', 'Shower chair or bench', 'Ramp', 'None of these']),
    mu('K.6', 'Around the house', ['Throw rugs in the walking paths', 'Tight hallways or doorways', 'A recliner or some way to sleep propped up', 'The path from bed to bathroom is dark at night', 'Clutter that would need clearing'], { area: 'house', detail: true }),
    lt('K.7', 'Anything about the house itself we should know?', { ph: 'Long or gravel driveway, trouble with heating or cooling, stairs in poor repair.' }),
    ch('K.7a', 'Do you own or rent?', ['Own', 'Rent', 'Live with family', 'Senior or assisted living'], { quick: true }),
    ch('K.7b', 'Would anything need permission before installing grab bars or a ramp?', ["Yes, we'd need the landlord", 'No', 'Not sure'], { when: is('K.7a', 'Rent', 'Live with family') }),
    ch('K.7c', "Do you have a good line to whoever'd approve that?", ['Yes', 'Not really', "Would rather we didn't ask"], { when: is('K.7a', 'Rent', 'Live with family'),
      why: 'Landlord permission takes days to weeks. If it’s needed, we start that now rather than the week before.' }),
    ch('K.8', 'How would someone we send get into the house?', ["Someone's always home", 'Hidden key', 'Lockbox — code shared separately', 'Garage code', 'Smart lock', 'A neighbor has a spare', "We'd rather be there every time", "Haven't thought about it"],
      { quick: true, tier: 2, why: "Please don't put a code on this form. We'll set that up separately and securely once we know what you'd prefer." }),
    lt('K.8a', 'Is there anything someone arriving should know?', { ph: "A dog that needs putting away first, a doorbell that doesn't work, a gate, a side entrance, a neighbor who'll want to know who they are." }),
    ch('K.9', 'If the surgery falls in winter — who clears the driveway and steps?', ['We handle it', 'We have a service', 'Nobody — that could be a problem', 'Not applicable']),
  ] },
  // ---------------------------------------------------------------- Section L
  { id: 'L', title: 'Getting around', qs: [
    ch('L.1', 'Who will drive {NAME} home from the hospital?', ['Someone named', "We haven't sorted this out yet"],
      { req: true, quick: true, noteOpen: true, nodk: true, details: { 'Someone named': NP },
        why: "We need this one. For most procedures with anesthesia or sedation, the hospital requires a specific adult to escort [[them|you]] home — a taxi or rideshare on its own usually isn't allowed, even if someone waits at the house. If it isn't settled, say so and we'll solve it." }),
    ch('L.2', 'Is there a licensed driver at home besides {NAME}?', ['Yes', 'No', 'Yes, but not always available'], { quick: true }),
    ch('L.3', 'Is there a car available?', ['Yes', 'No'], { quick: true }),
    ch('L.3a', 'Is it high up like an SUV or truck, or low like a sedan?', ['High', 'Low', 'In between'], { when: is('L.3', 'Yes'), area: 'rides', detail: true }),
    ch('L.3b', '{DOES} usually ride in front or back?', ['Front', 'Back'], { when: is('L.3', 'Yes'), area: 'rides', detail: true }),
    ch('L.3c', 'Garage, driveway, or street?', ['Garage', 'Driveway', 'Street'], { when: is('L.3', 'Yes'), area: 'rides', detail: true }),
    ch('L.3d', 'How far from the door to where it parks?', ['A few steps', 'Across a yard', 'Down the block'], { when: is('L.3', 'Yes') }),
    ch('L.3e', 'What do you normally use?', ['Public transit', 'Rideshare or taxi', 'Rides from family or friends', 'A medical transport service', 'Nothing reliable'],
      { when: is('L.3', 'No'), why: "Some insurance plans cover rides to medical appointments. We'll check what you qualify for." }),
    ch('L.4', 'How far is the hospital from home?', ['Under 20 minutes', '20–45 minutes', '45 minutes to 2 hours', 'More than 2 hours', 'Out of state'], { quick: true }),
    ch('L.5', 'For the hospital days, do you have somewhere to stay nearby if needed?', ['We live close enough', 'Yes, already arranged', "No, we'd like help", 'Not sure yet'],
      { when: all(svc('lodging'), not(is('G.9', 'Home the same day', 'One night'))) }),
    tx('L.5a', 'How many nights, roughly?', { when: { lodgingNeeded: true } }),
    tx('L.5b', 'How many people staying?', { when: { lodgingNeeded: true } }),
    ch('L.5c', 'When you travel, where do you usually stay?', ["Whatever's cheapest and clean", 'Something reliable — Hampton, Courtyard, Holiday Inn', 'Nicer end — Marriott, Hilton, Westin', "We'd rather have a house or apartment", "We don't travel much"], { when: { lodgingNeeded: true }, area: 'lodging', detail: true }),
    ch('L.5d', "Any hotel points or a brand you're loyal to?", ['Yes', 'No'], { when: { lodgingNeeded: true }, area: 'lodging', detail: true, details: { Yes: 'Which?' } }),
    ch('L.5e', 'Would a free family house near the hospital be welcome, or would you rather a hotel?', ['Free house is great if available', 'Would rather have our own space', 'Tell me more about the houses'],
      { when: { lodgingNeeded: true }, why: 'Hospital hospitality houses are free or near-free but shared, often with distance and referral rules, and they book up. Some families find them a relief; others find them hard.' }),
    mu('L.5f', 'What matters most? (Tick up to three)', ['Walking distance to the hospital', 'Cost', 'A kitchen', 'Room for more than two', 'Pet-friendly', 'Somewhere quiet to actually sleep', 'Laundry'], { when: { lodgingNeeded: true }, max: 3, area: 'lodging', detail: true }),
  ] },
  // ---------------------------------------------------------------- Section M
  { id: 'M', title: 'Household and dependents', qs: [
    ch('M.1', 'Are there children at home?', ['No', 'Yes'], { req: true, em: true, quick: true, nodk: true, details: { Yes: 'Ages' } }),
    ch('M.1a', '{DOES} normally lift them in and out of a car seat or crib?', ['Yes', 'No'], { when: all(svc('childcare'), ages(0, 2)) }),
    ch('M.1b', 'Is the crib or changing table at a height requiring bending?', ['Yes', 'No'], { when: all(svc('childcare'), ages(0, 2)), area: 'childcare', detail: true }),
    tx('M.1c', 'Daycare or preschool — full or partial days?', { when: all(svc('childcare'), ages(3, 5)) }),
    ch('M.1d', 'Do they still get carried much?', ['Often', 'Sometimes', 'Rarely'], { when: all(svc('childcare'), ages(3, 5)) }),
    tx('M.1e', 'What time is drop-off and pickup?', { when: all(svc('childcare'), ages(6, 11)) }),
    tx('M.1f', 'Any after-school activities with fixed times?', { when: all(svc('childcare'), ages(6, 11)), area: 'childcare', detail: true }),
    ch('M.1g', 'Is there a carpool you owe other families?', ['Yes', 'No'], { when: all(svc('childcare'), ages(6, 11)), area: 'childcare', detail: true }),
    ch('M.1h', 'Do any of them drive?', ['Yes', 'Learning', 'No'], { when: all(svc('childcare'), ages(12, 17)) }),
    ch('M.1i', 'Could they help at home — meals, younger siblings, the dog?', ['Yes', 'Some', 'Better not to lean on them'], { when: all(svc('childcare'), ages(12, 17)) }),
    ch('M.2', 'Would you like help finding the words to explain this — to children, family, or friends?', ['Yes, for the children', 'Yes, for adults too', 'No', 'Not applicable']),
    ch('M.2a', 'Have they been told anything yet?', ['Everything', 'Some of it', 'Nothing yet'], { when: is('M.2', 'Yes, for the children') }),
    ch('M.3', 'Is anyone else at home who needs daily help?', ['No', 'Yes — an older parent', 'Yes — another adult who needs care', 'Rather discuss in person', RNS_], { quick: true, tier: 3, noteOpen: true }),
    mu('M.4', 'Are there pets or animals?', ['No', 'Dog', 'Cat', 'Other'], { req: true, em: true, quick: true, nodk: true }),
    ch('M.4a', 'Roughly how much does the dog weigh?', ['Under 25 lb', '25–60 lb', 'Over 60 lb'], { when: all(svc('pets'), has('M.4', 'Dog')) }),
    ch('M.4b', 'Does it jump up on people?', ['Yes', 'Sometimes', 'No'], { when: all(svc('pets'), has('M.4', 'Dog')) }),
    ch('M.4c', 'Is there a fenced yard it can be let out into?', ['Yes', 'No'], { when: all(svc('pets'), has('M.4', 'Dog')),
      why: 'A fenced yard changes the job from hiring a walker twice a day for six weeks to someone opening a door.' }),
    ch('M.4d', 'How often does it actually need to go out?', ['Once a day is fine', 'Twice', 'Three or more', 'Just needs the door opened'], { when: all(svc('pets'), has('M.4', 'Dog')), area: 'pets', detail: true }),
    ch('M.4e', 'When you go away, what do you normally do?', ['Boarding kennel', 'Daycare or a nicer boarding place', 'A sitter comes to the house', 'A neighbor or family member', 'The dog comes with us', "We don't really go away"], { when: all(svc('pets'), has('M.4', 'Dog')), area: 'pets', detail: true }),
    ch('M.4f', 'During the hospital days, what would you prefer?', ['Same as what we normally do', "Someone at the house — we'd rather not move the dog", 'Boarding is fine', 'Ask a neighbor first, use a service only if that falls through'], { when: all(svc('pets'), has('M.4', 'Dog')), area: 'pets', detail: true }),
    lt('M.4g', 'Anything a stranger would need to know about the dog?', { when: all(svc('pets'), has('M.4', 'Dog')), ph: "Anxious with new people, escapes, doesn't like men, medication, guards food." }),
    tx('M.4h', 'How many cats?', { when: all(svc('pets'), has('M.4', 'Cat')) }),
    tx('M.4i', 'Who does the litter box?', { when: all(svc('pets'), has('M.4', 'Cat')) }),
    ch('M.4j', 'How often does it actually need doing?', ['Daily', 'Every couple of days', 'A few times a week'], { when: all(svc('pets'), has('M.4', 'Cat')), area: 'pets', detail: true }),
    ch('M.4k', 'Fine alone, or do they need company?', ['Fine alone', 'Some company', 'Very shy, better if nobody comes'], { when: all(svc('pets'), has('M.4', 'Cat')), area: 'pets', detail: true }),
    tx('M.4l', 'What kind of animal?', { when: all(svc('pets'), has('M.4', 'Other')) }),
    lt('M.4m', 'What does a minimum day look like — the least that has to happen?', { when: all(svc('pets'), has('M.4', 'Other')) }),
    lt('M.4n', 'And what would you normally do, on a good week?', { when: all(svc('pets'), has('M.4', 'Other')), area: 'pets', detail: true, why: 'The gap between "minimum day" and "good week" tells us where to spend.' }),
    ch('M.4o', 'Is there anyone nearby who could cover them?', ['Yes', 'No'], { when: all(svc('pets'), has('M.4', 'Other')) }),
    mu('M.5', 'What normally happens at home that would stop if things got busy?', ['Cooking', 'Grocery shopping', 'Laundry', 'Cleaning', 'Trash and recycling day', 'Lawn care or snow removal', 'Bills and mail', 'Plants or garden']),
  ] },
  // ---------------------------------------------------------------- Section N
  { id: 'N', title: 'Work and leave', qs: [
    ch('N.1', '{DOES} work?', ['No, or retired', 'Yes — mostly desk work', 'Yes — on [[their|your]] feet, lifting, physical', 'Yes — mixed'], { quick: true, details: { 'Yes — mostly desk work': 'When do they hope to return?', 'Yes — on [[their|your]] feet, lifting, physical': 'When do they hope to return?', 'Yes — mixed': 'When do they hope to return?' } }),
    tx('N.1a', 'What [[do they|do you]] do for work?', { when: { q: 'N.1', startsWith: 'Yes' }, tier: 3, alts: [RNS_], why: 'The actual job helps more than the category. "Electrician" tells us things "physical work" doesn\'t.' }),
    mu('N.1b', 'Does the job require any license or certification?', ["Commercial driver's license (CDL)", "Pilot's license", 'Nursing, medical, or other clinical license', 'Operating heavy machinery or equipment', 'Law enforcement, fire, or military', 'Something else that requires a medical sign-off', 'No license needed'],
      { when: { q: 'N.1', startsWith: 'Yes' }, quick: true, details: { 'Something else that requires a medical sign-off': 'What?' },
        why: "After brain or spine surgery, some licenses have their own medical clearance process — separate from, and often much longer than, ordinary driving rules. If any of these apply, we'll help you find out what's involved and start the paperwork early." }),
    ch('N.1c', 'Has [[their|your]] employer been told anything yet?', ['Yes, they know', "Only that there's a medical leave", 'Not yet', "Rather they didn't know details", RNS_], { when: { q: 'N.1', startsWith: 'Yes' }, tier: 3 }),
    ch('N.2', '{HELPER_DOES} work?', ['No', 'Yes — flexible or remote', 'Yes — fixed hours', 'Yes — shift work', 'Yes — self-employed or gig'], { quick: true }),
    tx('N.2a', 'What’s the job?', { when: { q: 'N.2', startsWith: 'Yes' }, tier: 3, alts: [RNS_], why: "A teacher's calendar, a nurse's rotation, and a contractor's schedule are three very different planning problems." }),
    ch('N.2c', 'Time at the hospital costs you income directly. Would it help if we built the schedule around protecting your work hours where we can?', ['Yes', "We'll manage"], { when: is('N.2', 'Yes — self-employed or gig') }),
    ch('N.2b', "Does anyone in the family work in healthcare, law, insurance, or anything else that's turned out useful here?", ['Yes', 'No'],
      { details: { Yes: 'Who and what?' }, why: "Not to put them to work — just so we're not explaining things they already know, or duplicating something they've already handled." }),
    ch('N.3', 'Can [[they|you]] take time off?', ['Yes, paid', 'Yes, unpaid', 'Only a little', 'No', "Not sure — we'd like help figuring out FMLA or disability"], { when: svc('leave'), noteOpen: true }),
    ch('N.3a', 'Roughly how many people work for [[{NAME_S}|your]] employer?', ['Fewer than 50', '50 or more', 'Not sure'], { when: all(svc('leave'), is('N.3', "Not sure — we'd like help figuring out FMLA or disability")) }),
    ch('N.3b', '[[Has {NAME}|Have you]] worked there at least a year?', ['Yes', 'No'], { when: all(svc('leave'), is('N.3', "Not sure — we'd like help figuring out FMLA or disability")) }),
    ch('N.3c', 'At least around 25 hours a week over that year?', ['Yes', 'No', 'Varies'], { when: all(svc('leave'), is('N.3', "Not sure — we'd like help figuring out FMLA or disability")),
      why: 'Those three are functionally the whole eligibility test. We can give you a real answer when we meet. (The fifty-employee rule is measured within seventy-five miles of the worksite — if you’re unsure, we’ll check.)' }),
    mu('N.4', 'Would you like help with any of these forms?', ['FMLA', 'Short- or long-term disability', 'Employer leave paperwork', 'A letter for a school', 'Insurance forms', 'Not sure yet'], { when: svc('leave') }),
  ] },
  // ---------------------------------------------------------------- Section O
  { id: 'O', title: 'Support and communication', qs: [
    ch('O.1', 'Has the hospital assigned anyone to you?', ['A case manager or discharge planner', 'A patient navigator', 'A social worker', 'Not that we know of', DK_], { nodk: true, details: { 'A case manager or discharge planner': 'Name' } }),
    mu('O.2', 'Is any of this already being set up?', ['Home health or a visiting nurse', 'Physical or occupational therapy', 'Paid caregivers or home aides', 'Medical equipment being delivered', 'None of these', DK_], { nodk: true }),
    lt('O.3', 'Has anyone already offered to help — and claimed specific days or jobs?', { alts: ["People have offered but nothing's organized", 'Nobody has offered', "We haven't asked"] }),
    ch('O.4', 'How often would you like updates from us?', ['Daily', 'A few times a week', 'Only when something needs a decision', 'Not sure yet'], { quick: true }),
    mu('O.5', 'Who are we permitted to speak with on your behalf?', ['Family members listed in Key contacts', "The hospital or surgeon's office", '[[{NAME_S} employer|My employer]]', 'A school', 'Vendors and providers we arrange', "Let's discuss"],
      { quick: true, why: "If you'd like us to speak directly with the care team, the hospital will need a signed release. We'll walk you through it — nothing for you to do right now." }),
    ch('O.6', 'Would a private page for surgery day help?', ['Yes', 'No', 'Maybe'], { when: svc('updates', 'page') }),
    lt('O.7', 'Who else should receive updates?', { when: svc('updates', 'page'), alts: ['Just the people in Key contacts'] }),
    ch('O.8', 'Is family traveling in?', ['No', 'Yes', 'Not sure yet'], { when: svc('updates', 'page', 'lodging'), details: { Yes: [f('count', 'How many'), f('when', 'Arriving around'), f('helpers', "Anyone who wants to help but doesn't know how?")] } }),
    ch('O.9', 'Would it help to have visits organized — who comes when?', ['Yes', 'No', 'Yes, and honestly we could use help slowing some people down'], { when: svc('updates', 'page') }),
    ch('O.10', 'Is there a church, synagogue, mosque, or community group in [[{NAME_S}|your]] life?', ['Yes', 'No', 'Not really active right now', RNS_], { tier: 3, details: { Yes: 'Which one?' } }),
    ch('O.10a', 'Have they offered help, or would they if asked?', ["They've already offered", 'They would if we asked', "We'd rather not ask", 'Not sure'],
      { when: all(is('O.10', 'Yes'), svc('meals')), why: 'Faith communities run some of the best meal rotations, transport, and visit schedules there are. If you’d like, we can coordinate with them so it’s organized rather than everyone arriving Tuesday.' }),
    ch('O.10b', 'Would you want a clergy visit arranged — yours, or the hospital chaplain?', ['Our own clergy', 'The hospital chaplain', 'Both', 'No thank you', '[[Ask {NAME}, not me|I’d like to think about it]]'], { when: is('O.10', 'Yes'), details: { 'Our own clergy': 'Contact' } }),
    lt('O.10c', "Is there anything you'd want to happen before surgery — a prayer, a blessing, anyone present?", { when: all(is('O.10', 'Yes'), not(is('G.6', EMERGENCY_))), alts: ['Nothing specific'],
      why: "These are easy to arrange and easy to forget in the rush. If it matters to your family, we'll make sure it happens." }),
    ch('O.10d', 'Are there days or times we should avoid scheduling things?', ['Sabbath or a weekly observance', 'Prayer times during the day', 'A regular service or meeting', 'Nothing to work around'], { details: { 'Sabbath or a weekly observance': 'Which?' } }),
    lt('O.10e', 'Are there any practices or customs we should know about — around the hospital, the home, or visitors?', { alts: ['Nothing specific', "We'd rather explain in person"],
      why: "We're not asking you to describe your beliefs. We're asking what you'd want honored, so we don't get it wrong." }),
    lt('O.11', "Is there anyone you'd prefer we not contact, or anything you'd rather keep private?", { tier: 3 }),
    tx('O.12', 'Where should we send your printed recovery roadmap?', { ph: 'Mailing address', alts: ['Digital is fine'] }),
  ] },
  // ---------------------------------------------------------------- Section O2 (the standards layer: food)
  { id: 'O2', title: 'Food', when: svc('meals'), standards: true, qs: [
    mu('O2.1', 'Is there anything about how your household eats that we need to build around?', ['Religious or observance requirements', 'Vegetarian or vegan', 'Food allergies', 'A medical or post-surgery diet from the care team', 'Strong preferences or dislikes', 'Nothing in particular — we eat most things']),
    ch('O2.2', 'Which applies?', ['Kosher', 'Halal', 'Hindu dietary practice', 'Jain', 'Buddhist dietary practice', 'Seventh-day Adventist', 'Latter-day Saint', 'Orthodox Christian fasting', 'Other', "We'd rather explain in person"],
      { when: has('O2.1', 'Religious or observance requirements'), details: { Other: 'What?' } }),
    ch('O2.2a', 'How would you describe how your household keeps kosher?', ['Kosher-style — no pork or shellfish, no mixing meat and dairy, certification not required', "We buy certified products but aren't strict about restaurants", 'Fully kosher kitchen — separate dishes, certified only', "We'd rather explain it"], { when: is('O2.2', 'Kosher') }),
    ch('O2.2b', "Can food prepared in someone else's kitchen come into the house?", ['Yes', 'Only sealed and certified', 'No, but people could cook here', 'No'], { when: is('O2.2', 'Kosher') }),
    tx('O2.2c', 'Is there a certification you look for?', { when: is('O2.2', 'Kosher'), alts: ['Any reliable hechsher', 'We just know the brands'] }),
    ch('O2.2d', 'Do you keep Shabbat in a way that affects food?', ['Yes — ready before sundown Friday', 'Somewhat', 'No'], { when: is('O2.2', 'Kosher') }),
    ch('O2.2e', 'Is a holiday falling in the recovery window?', ['Passover', 'Another', 'No', 'Not sure'], { when: is('O2.2', 'Kosher'), details: { Another: 'Which?' } }),
    ch('O2.2f', 'How would you describe your practice?', ['We avoid pork and alcohol, certification not required', 'We buy halal-certified meat', 'Zabiha only', "We'd rather explain it"], { when: is('O2.2', 'Halal') }),
    ch('O2.2g', "Can food from someone else's kitchen come into the house?", ['Yes', 'Only if certified', 'No, but people could cook here', 'No'], { when: is('O2.2', 'Halal') }),
    tx('O2.2h', 'A butcher, market, or restaurant you already use?', { when: is('O2.2', 'Halal') }),
    ch('O2.2i', 'Is Ramadan or a fasting period in the recovery window?', ['Yes', 'No', 'Not sure'], { when: is('O2.2', 'Halal') }),
    mu('O2.2j', 'Which applies?', ['No beef', 'Vegetarian', 'No onion or garlic', 'Fasting days', 'Other'], { when: is('O2.2', 'Hindu dietary practice'), details: { Other: 'What?' } }),
    ch('O2.2k', 'Does anything need preparing separately from meat?', ['Yes', 'No', "We'd rather explain"], { when: is('O2.2', 'Hindu dietary practice') }),
    mu('O2.2l', 'Which applies?', ['No root vegetables', 'Strictly vegetarian, no eggs', 'No eating after sunset', 'Other'], { when: is('O2.2', 'Jain'), details: { Other: 'What?' },
      why: 'Most delivery services can’t meet Jain requirements. Tell us who you normally rely on.' }),
    lt('O2.2m', 'Tell us in your own words what we should build around', { when: is('O2.2', 'Buddhist dietary practice', 'Seventh-day Adventist', 'Latter-day Saint', 'Orthodox Christian fasting', 'Other') }),
    ch('O2.2n', 'Any fasting period, holiday, or observance in the recovery window?', ['Yes', 'No', 'Not sure'], { when: is('O2.2', 'Buddhist dietary practice', 'Seventh-day Adventist', 'Latter-day Saint', 'Orthodox Christian fasting', 'Other'), details: { Yes: 'Which?' } }),
    ch('O2.3', 'Which describes the household?', ['Vegetarian, eggs and dairy fine', 'Vegetarian, no eggs', 'Pescatarian', 'Vegan', 'Some of us, not all'], { when: has('O2.1', 'Vegetarian or vegan'), details: { 'Some of us, not all': 'Who?' } }),
    ch('O2.3a', 'Is separate cookware or preparation needed?', ['Yes', 'No'], { when: has('O2.1', 'Vegetarian or vegan') }),
    lt('O2.4', 'Please list any allergies or intolerances, and for whom', { when: has('O2.1', 'Food allergies') }),
    ch('O2.4a', 'How serious?', ["Severe — cross-contamination matters, there's an epi-pen", 'Moderate', 'Mild or an intolerance'], { when: has('O2.1', 'Food allergies'),
      why: 'If severe, we name it explicitly to anyone preparing or delivering food, and avoid any source that can’t confirm.' }),
    ch('O2.4b', 'Anyone besides {NAME}?', ['[[Just {NAME}|Just me]]', 'Others'], { when: has('O2.1', 'Food allergies'), details: { Others: 'Who?' } }),
    mu('O2.5', 'What has the care team said?', ['Soft foods or easy to chew', 'Thickened liquids', 'Low sodium', 'Diabetic or carbohydrate-aware', 'Kidney or renal', 'Something about fiber or digestion', 'Not yet, but we expect instructions', 'Other'],
      { when: has('O2.1', 'A medical or post-surgery diet from the care team'), details: { Other: 'What?' } }),
    ch('O2.5a', 'Do you have it in writing?', ['Yes — please attach', 'Not yet', 'It was verbal'], { when: has('O2.1', 'A medical or post-surgery diet from the care team'), upload: true,
      why: "We follow exactly what your care team told you and never change or interpret it. If we're unsure whether something fits, we'll ask you to check with them rather than guess." }),
    tx('O2.6', 'Anything this household simply won’t eat?', { when: has('O2.1', 'Strong preferences or dislikes') }),
    tx('O2.6a', 'Is there a meal that would genuinely lift everyone’s spirits right now?', { when: has('O2.1', 'Strong preferences or dislikes') }),
    ch('O2.7', 'Who normally cooks?', ['[[{NAME} — the person having surgery|Me — the person having surgery]]', '{HELPER}', 'Shared', 'Nobody really — we eat out or order']),
    ch('O2.8', 'What does dinner normally look like?', ['Someone cooks most nights', 'Mix of cooking and takeout', 'Mostly takeout or delivery', 'Meal kits or a delivery service', 'It varies'], { area: 'meals', detail: true }),
    mu('O2.9', 'For the busy stretch, what would help most?', ['A freezer stocked ahead', 'Meals from friends and family, organized', 'Restaurant delivery', 'A meal service subscription', "Groceries delivered, we'll cook"]),
    ch('O2.10', "Roughly what's a normal dinner spend for your household?", ['We keep it cheap', 'Middle of the road', "We don't really watch it", RNS_], { tier: 3, area: 'meals', detail: true }),
    ch('O2.11', 'Is there freezer space to stock ahead?', ['Plenty', 'Some', 'Not really', "There's a deep freezer"], { area: 'meals', detail: true }),
    lt('O2.12', 'Anything about the kitchen we should know?', { ph: "Separate dishes, a second refrigerator, an oven that doesn't work, no dishwasher.", area: 'meals', detail: true }),
    mu('O2.13', 'Who else is eating?', ['[[Just {NAME}|Just me]]', 'Kids', 'Other adults', 'People visiting'], { details: { Kids: 'Ages, and do they eat what the adults eat?' } }),
    tx('O2.14', 'Grocery store you normally use', { area: 'meals', detail: true, ph: 'And any delivery service you already use' }),
    lt('O2.15', 'Is there a restaurant, market, caterer, or bakery you already trust to get this right?',
      { why: "This is the most useful question here. You already know who gets it right — we'd rather use them than guess." }),
    ch('O2.15a', 'Would you rather we used them, even if it costs a bit more?', ['Yes, please', "Whatever's easiest", "We're open to suggestions"], { when: filled('O2.15') }),
  ] },
  // ---------------------------------------------------------------- Section O3 (the standards layer: how you like things done)
  { id: 'O3', title: 'How you like things done', lead: 'Only the parts matching what you asked for are here.', standards: true, qs: [
    ch('O3.1', "How do you feel about someone you haven't met being in the house?", ["Fine, as long as they're vetted", 'Prefer to meet them first', "We'd rather it be someone we already know", "We'd rather not, honestly"], { when: svc('childcare', 'house', 'pets') }),
    ch('O3.2', 'For childcare, would you rather:', ['Family or friends, organized by you', 'A professional sitter or agency', "Whoever's available"], { when: svc('childcare'), area: 'childcare', detail: true }),
    mu('O3.3', 'Any preferences we should honor for anyone coming into the home?', ['Same gender as [[{NAME}|me]] for personal care', 'Someone who speaks another language', 'Background check we can see', 'Comfortable with our pets', 'No preferences'],
      { when: svc('childcare', 'house', 'pets'), details: { 'Someone who speaks another language': 'Which language?' } }),
    ch('O3.4', 'How often would help around the house be useful?', ['Once, before surgery', 'Weekly', 'A couple of times a week', 'Daily at first, then less', "We'd rather handle it"], { when: svc('house'), area: 'house', detail: true }),
    mu('O3.5', 'For appointments, what would you be comfortable with?', ['Rideshare is fine', 'A scheduled car service', 'Someone we know', 'Medical transport, if [[{NAME} needs|I need]] help getting in and out'], { when: svc('rides') }),
    tx('O3.6', "Anyone who'd be glad to drive if we asked for them?", { when: svc('rides'), area: 'rides', detail: true }),
    ch('O3.7', 'For things like a walker, shower chair, or raised toilet seat:', ["Basic and cheap, it's temporary", 'Something decent, we may need it a while', 'Whatever insurance covers', "Best available, we'll pay the difference"], { when: svc('equipment'), area: 'equipment', detail: true }),
    ch('O3.8', 'Rent or buy?', ['Rent — we want it gone afterward', 'Buy — simpler', 'Whichever is cheaper', 'Advise us'], { when: svc('equipment'), area: 'equipment', detail: true }),
    ch('O3.9', 'Anything already in the family — a walker in a closet, a wheelchair from before?', ['Yes', 'No', 'Worth asking around'], { when: svc('equipment'), details: { Yes: 'What?' } }),
    ch('O3.10', 'Do you already have someone for lawn or snow?', ['Yes, just keep them on', 'No, we do it ourselves', "No, and we'd need someone"], { when: svc('house'), area: 'house', detail: true }),
    ch('O3.11', 'Standing arrangement, or just the recovery window?', ['Standing', 'Just the recovery window', 'One-time, before surgery'], { when: svc('house'), area: 'house', detail: true }),
    ch('O3.12', "How much do you want to know about the things we're handling?", ['Everything — send me the details', 'The important parts', "Just tell me when it's done", 'Only contact me if something needs a decision']),
    ch('O3.13', 'If something small goes wrong and we fix it — do you want to hear about it?', ['Yes, always', 'Only if it cost money or changed the plan', 'No, just handle it']),
    mu('O3.14', 'If we could only do a few of these really well, what would you want them to be? (Your top three, in order)', ['Getting the house ready', 'Rides and appointments', 'Meals and groceries', 'Kids', 'Pets', 'Paperwork and bills', 'Keeping everyone updated', '[[Someone with {NAME} so they’re not alone|Someone with me so I’m not alone]]', '[[Support for me|Support for my caregiver]]'], { max: 3, ordered: true }),
    lt('O3.15', "Is there anything here you'd honestly rather we didn't touch?", { why: "This one matters. Families often want to keep the parts that feel meaningful and hand off the rest. We'd rather know than assume." }),
  ] },
  // ---------------------------------------------------------------- Section P
  { id: 'P', title: "How you're doing", lead: "[[This part is about you, not {NAME}.|This part is about how you’re holding up — not the surgery itself.]] Most people skip straight past it. We'd rather you didn't.", qs: [
    ch('P.1', 'How are you holding up?', ['Managing fine', 'Stretched but coping', 'Running on empty', RNS_], { tier: 3, nodk: true }),
    ch('P.1a', 'Thank you for saying that. Would it help to talk through what could come off your plate first?', ['Yes', 'Not right now'], { when: is('P.1', 'Running on empty'), nodk: true }),
    lt('P.2', "Is there anything you're carrying that nobody has offered to help with?", { when: svc('caregiver') }),
    ch('P.3', 'Would you want us checking in on you as well, not only {NAME}?', ['Yes', 'No', 'Maybe later'], { when: all(svc('caregiver'), not(role('patient'))), nodk: true }),
    ch('P.4', "After the first few weeks, when everyone else's attention moves on — would regular check-ins be welcome?", ['Yes', 'No', "Let's see how things go"], { when: svc('caregiver'), nodk: true }),
    ch('P.5', 'Have you been through a major surgery in the family before?', ['First time', "We've done this before", "We've done it before and it didn't go well", RNS_], { tier: 3, nodk: true }),
    lt('P.6', 'Is there anything else you want us to know?', { quick: true, ph: "Anything at all. Things that don't fit a box are often the most useful things you can tell us." }),
    ch('P.7', 'How did you hear about us?', ['A friend or family member', 'Someone at the hospital', "A doctor's office", 'Online search', 'Social media', 'A support group', 'Other'], { nodk: true, details: { Other: 'Where?' } }),
  ] },
  // ---------------------------------------------------------------- Section Q
  { id: 'Q', title: 'Budget (optional)', when: not(is('G.6', EMERGENCY_)), catchAll: false,
    lead: 'Personal and entirely optional. Skip them and we’ll talk it through if and when it matters. We find and set up services, and you pay those providers directly. We never handle your money.', qs: [
    ch('Q.1', 'Are you managing this mostly on your own?', ['Several of us share it', 'One other person', 'Mostly on my own', RNS_], { tier: 3, nodk: true }),
    ch('Q.2', "A rough budget you'd want us to stay within for meals, rides, pet care, or extra help?", ['Under $500', '$500–1,500', '$1,500–3,000', 'More than $3,000', 'Start with low-cost and free options', "Let's discuss", RNS_], { tier: 3, nodk: true }),
    ch('Q.3', 'Who approves spending before we commit to a cost?', ['The person filling this out', 'Someone else'], { details: { 'Someone else': 'Who?' }, nodk: true }),
    ch('Q.4', 'Is cost a significant worry right now?', ['No', 'Somewhat', "Yes — we'd want free or subsidized options", RNS_], { tier: 3, nodk: true }),
  ] },
];

// Every section but 0, A, B and Q closes with an optional catch-all, collapsed.
const TOPIC = { C: 'your key contacts', D: 'reaching {NAME}', E: 'insurance', F: 'what would help', G: 'the diagnosis and the surgery', H: 'appointments', H2: 'surgery day', I: 'what {NAME} can do', J: 'medications', K: 'the home', L: 'getting around', M: 'the household', N: 'work and leave', O: 'support and communication', O2: 'food', O3: 'how you like things done' };
INTAKE_STEPS_.forEach(st => {
  if (st.catchAll === false || !TOPIC[st.id]) return;
  st.qs.push(lt(st.id + '.x', 'Anything else about ' + TOPIC[st.id] + ' we should know?', { collapsed: true, nodk: true, catchAll: true }));
});
// Tier 2 and Tier 3 offer their way out as an option (the page adds it when the question does not list it already).
INTAKE_STEPS_.forEach(st => st.qs.forEach(x => {
  if (x.tier === 2 && (x.type === 'choice' || x.type === 'multi') && x.opts.indexOf(DISCUSS_) < 0 && x.opts.indexOf('Rather discuss in person') < 0) x.opts = x.opts.concat([DISCUSS_]);
  if (x.tier === 2 && x.type === 'text' && !(x.alts || []).includes(DISCUSS_)) x.alts = (x.alts || []).concat([DISCUSS_]);
  if (x.tier === 3 && (x.type === 'choice' || x.type === 'multi') && x.opts.indexOf(RNS_) < 0) x.opts = x.opts.concat([RNS_]);
  if (x.tier === 3 && x.type === 'text' && !(x.alts || []).includes(RNS_)) x.alts = (x.alts || []).concat([RNS_]);
  // "I don't know" is on every choice question, unless it already has its own "not sure", or it is marked nodk.
  if ((x.type === 'choice' || x.type === 'multi') && !x.nodk && !x.opts.some(o => /^(Not sure|Don't know|I don't know|Nobody said|No idea)/.test(o))) x.opts = x.opts.concat([DK_]);
}));

const CONSENT_ITEMS_ = [
  ['We are a non-clinical support service.', 'InCadence Care LLC is not a healthcare provider. We do not diagnose, treat, prescribe, or give medical advice. Your care team does that.'],
  ['Health information you share with us.', "You'll tell us about the diagnosis and the surgery because it shapes the support plan we build. We use it only for that. We don't interpret it, advise on it, or tell you what to expect medically, and we don't share it with anyone without your written permission."],
  ['We coordinate; you pay providers directly.', 'We find and arrange services on your behalf. Payment goes from you to those providers. We never take custody of your funds.'],
  ['Records and authorizations.', "If we're helping with records, bills, or authorizations, we'll send separate release forms — one per provider."],
  ['Medications.', "If we're helping with medication organization, we'll collect the medication list separately and only with your written permission. We build the schedule your care team prescribed. We never advise on what to take or how much."],
  ['Appointment recording.', "If we're joining appointments, we'll ask the clinician's permission before recording anything, every time."],
  ['Your information.', "We store what you've given us securely and use it only to arrange the support you've asked for. You may ask us to correct or delete it at any time."],
  ['How we prepare your plan.', "Secure software keeps your answers organized. Your plan is written by a person, your coordinator, and reviewed before you see it. We never sell your information or use it to train software."],
  ['In an emergency, call 911.', 'For mental health crisis support, call or text 988.']
];

// hospitals: the names for the hospital question (G.7), from the hospital list; the API fills them in (intake.specFor).
module.exports = {
  DK_, DISCUSS_, RNS_, EMERGENCY_, INTAKE_STEPS_, CONSENT_ITEMS_, SERVICES, SVC_BY_TEXT, SVC_TEXT, DEPTH_OPTS, JUST_HANDLE, DEPTH_AREAS,
  intakeSpec: (hospitals) => ({ steps: INTAKE_STEPS_, consent: CONSENT_ITEMS_, dk: DK_, discuss: DISCUSS_, rns: RNS_, emergency: EMERGENCY_,
    services: SVC_BY_TEXT, justHandle: JUST_HANDLE, hospitals: hospitals || [] }),
};
