'use strict';
// Verbatim from Intake.gs (the master intake form). Edit there and here together.
const DK_ = "I don't know";
const DISCUSS_ = 'Rather discuss this with you directly';

// {NAME} = patient's first name, or "you" when the patient is filling it out.
// {NAME_S} = "Sam's" / "your".  {DOES} = "Does Sam" / "Do you".
const INTAKE_STEPS_ = [
  { id: 'start', title: 'Before we start', lead: 'Two quick questions about how you want to do this.', qs: [
    { id: '0.1', q: "Who's filling this out?", type: 'choice', req: true, opts: ["I'm the person having surgery", "I'm a family member or friend", "We're doing it together"] },
    { id: '0.1a', q: 'How would you like to do this?', type: 'choice', req: true,
      opts: ['Quick — just the essentials, we will sort the details out when we talk', 'Thorough — ask me everything, I would rather get it right on paper', 'Let me decide as I go — I will go deep on the parts that matter to me'],
      why: "There's no right answer. Some people want to spell everything out; others would rather hand it over. Both work fine for us, and you can change your mind at any point." }
  ]},
  { id: 'who', title: 'Who this is for', lead: 'The basics we need before anything else.', qs: [
    { id: 'A.name', q: "{NAME_CAP} full name", type: 'text', req: true, ph: 'First and last' },
    { id: 'A.phone', q: 'Best phone number for {NAME_OBJ}', type: 'text', req: true, ph: '(615) 555-0100',
      why: 'A working number is one of the few things we cannot do without.' },
    { id: 'A.2', q: '{DOES} live alone?', type: 'choice', req: true, opts: ['Lives with others', 'Lives alone'], noteOpen: true,
      why: 'We need this one. Most procedures require someone to be with the patient the first night, so it changes what has to be arranged before surgery.' },
    { id: 'A.2a', q: 'Is there someone who could stay the first night or two?', type: 'choice', showIf: { id: 'A.2', is: ['Lives alone'] },
      opts: ['Yes', 'No', "Maybe, I'd need to ask"], detailOn: 'Yes', detailLabel: 'Who?',
      why: "If there's nobody, that's usually the first thing we solve — and it's very solvable. Don't worry about it before we talk." }
  ]},
  { id: 'surgery', title: 'The diagnosis and the surgery', lead: 'In your own words is fine. We never interpret this or advise on it — that is your care team\'s work.', qs: [
    { id: 'G.1', q: 'What are you dealing with?', type: 'text', req: true, long: true, ph: 'Whatever the doctors have told you, however you would explain it to a friend.',
      alts: ["We're still waiting to find out", DISCUSS_] },
    { id: 'G.4', q: 'What surgery is planned?', type: 'text', req: true, alts: ["We don't have a name for it yet"] },
    { id: 'G.6', q: 'Surgery date', type: 'date', req: true, alts: ['Not scheduled yet', 'This is an emergency, or it has already happened'] },
    { id: 'G.6a', q: 'Where are things right now?', type: 'choice', showIf: { id: 'G.6', is: ['This is an emergency, or it has already happened'] },
      opts: ['Still in surgery', 'In the ICU', 'On a regular floor', 'Discharge is being discussed', 'Already home'] },
    { id: 'G.6b', q: "What's the most pressing thing in the next 48 hours?", type: 'text', long: true, showIf: { id: 'G.6', is: ['This is an emergency, or it has already happened'] } },
    { id: 'G.9', q: 'Expected hospital stay', type: 'choice', req: true, opts: ['Home the same day', 'One night', '2–3 nights', '4–7 nights', 'More than a week', DK_] },
    { id: 'G.10', q: 'After the hospital, {IS} expected to go straight home?', type: 'choice', req: true, noteOpen: true,
      opts: ['Straight home', 'To rehab or a nursing facility first', DK_],
      why: 'This matters more than almost anything else on this form.' },
    { id: 'G.11', q: 'What health insurance covers {NAME_OBJ}?', type: 'multi', opts: ['Medicare', 'Medicare Advantage', 'Medicaid', 'Private or through work', 'VA or TRICARE', 'None', DK_],
      why: 'Pick all that apply. It tells us what rehab, equipment and home help are likely to be covered.' }
  ]},
  { id: 'home', title: 'Getting home, and the household', lead: 'Three things that shape the first week.', qs: [
    { id: 'L.1', q: 'Who will drive {NAME_OBJ} home from the hospital?', type: 'text', req: true, ph: 'Name and phone', noteOpen: true,
      alts: ["We haven't sorted this out yet"],
      why: "We need this one. For most procedures with anesthesia or sedation, the hospital requires a specific adult to escort them home — a taxi or rideshare on its own usually isn't allowed, even if someone waits at the house. If it isn't settled, say so and we'll solve it." },
    { id: 'M.1', q: 'Are there children at home?', type: 'choice', req: true, opts: ['No', 'Yes'], detailOn: 'Yes', detailLabel: 'Ages' },
    { id: 'M.4', q: 'Are there pets or animals?', type: 'multi', req: true, opts: ['No', 'Dog', 'Cat', 'Other'], detailOn: 'Other', detailLabel: 'What kind?' }
  ]},
  { id: 'most', title: 'What would help most', lead: 'The last two, and the most useful.', qs: [
    { id: 'F.1', q: 'If you could only pick one thing for us to take off your plate, what would it be?', type: 'text', req: true, long: true },
    { id: 'P.6', q: 'Is there anything else you want us to know?', type: 'text', long: true, ph: "Anything at all. Things that don't fit a box are often the most useful things you can tell us." }
  ]}
];

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

module.exports = { DK_, DISCUSS_, INTAKE_STEPS_, CONSENT_ITEMS_, intakeSpec: () => ({ steps: INTAKE_STEPS_, consent: CONSENT_ITEMS_, dk: DK_, discuss: DISCUSS_ }) };
