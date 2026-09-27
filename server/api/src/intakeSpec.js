'use strict';
// Verbatim from Intake.gs (the master intake form). Edit there and here together.
const DK_ = "I don't know";
const DISCUSS_ = 'Rather discuss this with you directly';

// {NAME} = patient's first name, or "you" when the patient is filling it out.
// {NAME_S} = "Sam's" / "your".  {DOES} = "Does Sam" / "Do you".  {DOES_KNOW} = "Does Sam know you're filling this out?"
// em: true = asked on the emergency path (surgery already happened); the rest wait until the family circles back.
const INTAKE_STEPS_ = [
  { id: 'start', title: 'Before we start', lead: 'Two quick questions about how you want to do this.', qs: [
    { id: '0.1', em: true, q: "Who's filling this out?", type: 'choice', req: true, opts: ["I'm the person having surgery", "I'm a family member or friend", "We're doing it together"] },
    { id: '0.1a', em: true, q: 'How would you like to do this?', type: 'choice', req: true,
      opts: ['Quick — just the essentials, we will sort the details out when we talk', 'Thorough — ask me everything, I would rather get it right on paper', 'Let me decide as I go — I will go deep on the parts that matter to me'],
      why: "There's no right answer. Some people want to spell everything out; others would rather hand it over. Both work fine for us, and you can change your mind at any point." }
  ]},
  { id: 'who', title: 'Who this is for', lead: 'The basics we need before anything else.', qs: [
    { id: 'A.name', em: true, q: "{NAME_CAP} full name", type: 'text', req: true, ph: 'First and last' },
    { id: 'A.phone', em: true, q: 'Best phone number for {NAME_OBJ}', type: 'text', req: true, ph: '(615) 555-0100',
      why: 'A working number is one of the few things we cannot do without.' },
    { id: 'A.2', em: true, q: '{DOES} live alone?', type: 'choice', req: true, opts: ['Lives with others', 'Lives alone'], noteOpen: true,
      why: 'We need this one. Most procedures require someone to be with the patient the first night, so it changes what has to be arranged before surgery.' },
    { id: 'A.2a', em: true, q: 'Is there someone who could stay the first night or two?', type: 'choice', showIf: { id: 'A.2', is: ['Lives alone'] },
      opts: ['Yes', 'No', "Maybe, I'd need to ask"], detailOn: 'Yes', detailLabel: 'Who?',
      why: "If there's nobody, that's usually the first thing we solve — and it's very solvable. Don't worry about it before we talk." }
  ]},
  { id: 'people', title: 'The people around {NAME_OBJ}', lead: 'Who we talk to, and who steps in.', qs: [
    { id: 'A.3', em: true, q: 'Who is the one main contact for the surgical team?', type: 'text', req: true, ph: 'Name and phone', noteOpen: true,
      why: 'One named person, so messages from the hospital never cross. It can be the patient.' },
    { id: 'A.4', em: true, q: 'If that person gets sick or hits a wall, who is the backup?', type: 'text', ph: 'Name and phone', alts: ["There isn't one yet"],
      why: 'A single point of failure is the most common way a plan falls apart. We name the backup now, while it is easy.' },
    { id: 'A.5', q: '{DOES_KNOW}', type: 'choice', showIf: { id: '0.1', is: ["I'm a family member or friend"] }, opts: ['Yes', 'Not yet', 'Partly'], noteOpen: true,
      why: 'It changes how we reach out, and it is fine either way.' },
    { id: 'A.6', q: 'May we contact {NAME_OBJ} directly?', type: 'choice', showIf: { id: '0.1', is: ["I'm a family member or friend"] }, opts: ['Yes', 'Through me for now', 'Not yet'] }
  ]},
  { id: 'surgery', title: 'The diagnosis and the surgery', lead: 'In your own words is fine. We never interpret this or advise on it — that is your care team\'s work.', qs: [
    { id: 'G.1', em: true, q: 'What are you dealing with?', type: 'text', req: true, long: true, ph: 'Whatever the doctors have told you, however you would explain it to a friend.',
      alts: ["We're still waiting to find out", DISCUSS_] },
    { id: 'G.4', q: 'What surgery is planned?', type: 'text', req: true, alts: ["We don't have a name for it yet"] },
    { id: 'G.6', em: true, q: 'Surgery date', type: 'date', req: true, alts: ['Not scheduled yet', 'This is an emergency, or it has already happened'] },
    { id: 'G.6h', em: true, q: 'Which hospital is the surgery at?', type: 'select', req: true, optsFrom: 'hospitals', ph: 'Choose the hospital',
      alts: ['Somewhere else', "We don't know yet"], detailOn: 'Somewhere else', detailLabel: 'Which hospital, and which city?',
      why: 'For the hospitals we know, this puts the campus map, parking, the entrance to use and help nearby on your plan.' },
    { id: 'G.6a', em: true, q: 'Where are things right now?', type: 'choice', showIf: { id: 'G.6', is: ['This is an emergency, or it has already happened'] },
      opts: ['Still in surgery', 'In the ICU', 'On a regular floor', 'Discharge is being discussed', 'Already home'] },
    { id: 'G.6b', em: true, q: "What's the most pressing thing in the next 48 hours?", type: 'text', long: true, showIf: { id: 'G.6', is: ['This is an emergency, or it has already happened'] } },
    { id: 'G.9', q: 'Expected hospital stay', type: 'choice', req: true, opts: ['Home the same day', 'One night', '2–3 nights', '4–7 nights', 'More than a week', DK_] },
    { id: 'G.10', em: true, q: 'After the hospital, {IS} expected to go straight home?', type: 'choice', req: true, noteOpen: true,
      opts: ['Straight home', 'To rehab or a nursing facility first', DK_],
      why: 'This matters more than almost anything else on this form.' },
    { id: 'G.11', q: 'What health insurance covers {NAME_OBJ}?', type: 'multi', opts: ['Medicare', 'Medicare Advantage', 'Medicaid', 'Private or through work', 'VA or TRICARE', 'None', DK_],
      why: 'Pick all that apply. It tells us what rehab, equipment and home help are likely to be covered.' },
    { id: 'G.12', q: 'Medicaid often covers rides to appointments, and the VA reimburses travel. Want us to check those for you?', type: 'choice', showIf: { id: 'G.11', any: ['Medicaid', 'VA or TRICARE'] }, opts: ['Yes, please', 'Already using it', 'No thanks'],
      why: 'Free wins. Most families never hear about them.' }
  ]},
  { id: 'home', title: 'Getting home, and the household', lead: 'Three things that shape the first week.', qs: [
    { id: 'L.1', em: true, q: 'Who will drive {NAME_OBJ} home from the hospital?', type: 'text', req: true, ph: 'Name and phone', noteOpen: true,
      alts: ["We haven't sorted this out yet"],
      why: "We need this one. For most procedures with anesthesia or sedation, the hospital requires a specific adult to escort them home — a taxi or rideshare on its own usually isn't allowed, even if someone waits at the house. If it isn't settled, say so and we'll solve it." },
    { id: 'M.1', q: 'Are there children at home?', type: 'choice', req: true, opts: ['No', 'Yes'], detailOn: 'Yes', detailLabel: 'Ages' },
    { id: 'M.4', q: 'Are there pets or animals?', type: 'multi', req: true, opts: ['No', 'Dog', 'Cat', 'Other'], detailOn: 'Other', detailLabel: 'What kind?' },
    { id: 'L.2', q: 'Which pharmacy, and is it open on weekends?', type: 'text', ph: 'Name, town — and Saturday/Sunday hours if you know them', alts: [DK_],
      why: 'A Friday-afternoon discharge with a pharmacy closed Saturday is a scramble we can head off.' },
    { id: 'L.3', q: 'Any of this already at home?', type: 'multi', opts: ['Walker', 'Shower chair or bench', 'Raised toilet seat', 'Grab bars', 'Recliner', 'None of these', DK_],
      why: 'What is missing becomes a task, and someone usually has a walker in a closet.' },
    { id: 'L.4', q: 'If somebody needs a place to stay near the hospital, what matters most?', type: 'multi', opts: ['Cheapest', 'Closest to the hospital', 'A kitchen', 'Allows pets', 'Wheelchair accessible', 'Free family housing if there is any', "Won't need one"], detailOn: 'Cheapest', detailLabel: 'Nights and a budget, if you know them' }
  ]},
  { id: 'work', title: 'Work', lead: 'Only what changes the plan.', qs: [
    { id: 'W.1', q: 'Has {NAME_S} employer been told?', type: 'choice', opts: ['Yes', 'Not yet', 'Not working right now', 'Self-employed'], noteOpen: true,
      why: 'Leave paperwork (FMLA, disability, a letter) takes time to start. We prepare it; you send it.' },
    { id: 'W.2', q: 'Is it a licensed job — driving (CDL), flying, clinical work, heavy machinery?', type: 'choice', showIf: { id: 'W.1', is: ['Yes', 'Not yet', 'Self-employed'] }, opts: ['No', 'Yes'], detailOn: 'Yes', detailLabel: 'Which?',
      why: 'These often need their own medical sign-off to go back. Starting early avoids a surprise.' }
  ]},
  { id: 'faith', title: 'Faith and community', lead: 'Skip anything that does not apply.', qs: [
    { id: 'S.1', q: 'Would a prayer, a blessing, or a visit from clergy or a chaplain be welcome before surgery?', type: 'choice', opts: ['Yes, please', 'No, thank you', "Let's talk about it"], detailOn: 'Yes, please', detailLabel: 'Who, or which community?' },
    { id: 'S.2', q: 'Does a church or faith community help with meals or visits?', type: 'choice', opts: ["Yes, and we'd welcome it", "They would, but we'd rather not ask", 'No', 'Not sure'],
      why: 'Faith communities often run the best meal rotations. We can coordinate with them, or leave it alone.' }
  ]},
  { id: 'most', title: 'What would help most', lead: 'The last two, and the most useful.', qs: [
    { id: 'F.1', em: true, q: 'If you could only pick one thing for us to take off your plate, what would it be?', type: 'text', req: true, long: true },
    { id: 'H.1', q: 'What are you most afraid of?', type: 'text', long: true, ph: 'Say it plainly. Nobody grades this.' },
    { id: 'H.2', q: 'What are you hoping for, on the other side of this?', type: 'text', long: true, ph: 'The thing you want to get back to.' },
    { id: 'P.1', q: 'Is there anything {NAME_OBJ} is adamant about doing themselves?', type: 'text', long: true, ph: 'Some people want the driving, the cooking, or the phone calls to stay theirs. Tell us.' },
    { id: 'P.2', q: "Is there anything you'd rather we didn't touch?", type: 'text', long: true, ph: 'Any part of life we should leave alone.' },
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

// hospitals: the names for the hospital question (G.6h), from the hospital list; the API fills them in (intake.specFor).
module.exports = { DK_, DISCUSS_, INTAKE_STEPS_, CONSENT_ITEMS_, intakeSpec: (hospitals) => ({ steps: INTAKE_STEPS_, consent: CONSENT_ITEMS_, dk: DK_, discuss: DISCUSS_, hospitals: hospitals || [] }) };
