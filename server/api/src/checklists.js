'use strict';
// The family's checklists (added 2026-09-27): the surgery-day readiness list, the two packing lists, the three
// questions before leaving the hospital, and the landing zone at home. The lists are fixed text; what each
// family has ticked lives in checklist_ticks. Every item that touches a clinical decision points back to the
// care team, we track that the family knows the answer, we never supply it.
//
// when: the stage the list belongs to (it sorts to the top when the family is there). fridge: printable.
const CHECKLISTS = [
  { id: 'ready', title: 'Ready for surgery day', when: 'The last week', lead: 'The things that cancel surgeries on the day. Tick each one once the whole household knows it.', items: [
    { id: 'fast', text: 'Everyone in the house knows the fasting cut-off, food and drink, and from when', note: 'From the pre-op call. Write the stop times down; they are the team’s rules.' },
    { id: 'stop', text: 'Medication stop dates are on the calendar, exactly as the team wrote them', note: 'The team decides which, and when; you track the dates they gave.' },
    { id: 'tests', text: 'Pre-op tests are done and the results were confirmed back to the surgeon', note: 'Ask the office: “Do you have everything you need from us?”' },
    { id: 'auth', text: 'Insurance authorization is confirmed', note: 'Call the number on the card and ask for the authorization number.' },
    { id: 'sick', text: 'You know what to do if anyone in the house gets sick this week', note: 'A cold, a fever, a dental or skin problem, tell the team, do not hide it.' },
    { id: 'time', text: 'Report time, which building, which entrance, and where to park', note: 'Report time is earlier than surgery time.' },
    { id: 'body', text: 'Jewelry, contacts, nail polish, hearing aids, dentures, you know what comes off and what comes along', note: 'Labeled cases for glasses, dentures and hearing aids, with spare batteries.' },
    { id: 'interp', text: 'An interpreter is booked, if one is needed' },
    { id: 'who', text: 'Who comes, who stays, and who gets the updates', note: 'The hospital usually texts two people. Decide which two.' },
    { id: 'long', text: 'You have planned for a longer day than the estimate', note: 'Chargers, a battery pack, downloaded shows, snacks for whoever is waiting.' }
  ]},
  { id: 'packpt', title: 'Packing: the patient’s bag', when: 'The last week', lead: 'Pack two or three days early, not the night before. Hand valuables to whoever is staying.', items: [
    { id: 'tops', text: 'Front-opening tops and slip-on shoes' },
    { id: 'cable', text: 'A long charging cable and a battery pack', note: 'Many ICU beds have a USB port. Many do not.' },
    { id: 'shows', text: 'Shows or books downloaded, hospital Wi-Fi is bad' },
    { id: 'pillow', text: 'A pillowcase that is not white, an eye mask, earplugs' },
    { id: 'tooth', text: 'Your own toothbrush and lip balm' },
    { id: 'cpap', text: 'CPAP or inhaler, if you use one', note: 'Tell the team you are bringing it.' },
    { id: 'cases', text: 'Labeled cases for glasses, dentures, hearing aids, with spare batteries' },
    { id: 'notebook', text: 'A notebook and a pen', note: 'For questions, and for what the doctor said on rounds.' },
    { id: 'scent', text: 'Scented products left at home' },
    { id: 'nights', text: 'You asked how many nights to plan for, and whether a neuro-ICU stay is possible' }
  ]},
  { id: 'packst', title: 'Packing: the bag for whoever is staying', when: 'The last week', lead: 'Separate bag. Waiting is its own work.', items: [
    { id: 'charge', text: 'Charger, battery pack, headphones' },
    { id: 'layers', text: 'Layers, waiting rooms run cold' },
    { id: 'food', text: 'Snacks and a refillable bottle', note: 'Cafeterias close. Somebody should make sure whoever is waiting gets fed.' },
    { id: 'list', text: 'The one-page medication list and the surgeon’s office number' },
    { id: 'valuables', text: 'The patient’s wallet, phone and keys' },
    { id: 'contacts', text: 'The list of who gets updates, and how' },
    { id: 'sleep', text: 'Something to sleep with if you might stay overnight, pillow, blanket, eye mask' },
    { id: 'parking', text: 'Parking sorted: where, how much, whether it is validated' }
  ]},
  { id: 'leave', title: 'Before you leave the hospital', when: 'ICU', lead: 'Three things written down before the wheelchair reaches the door. Ask the nurse; do not leave without them.', items: [
    { id: 'meds', text: 'The exact medication schedule, what, how much, when, and what to do if a dose is missed', note: 'On paper. Photograph it too.' },
    { id: 'call', text: 'Who to call once you are home, at what number, and what counts as “call now”', note: 'The post-op line, the after-hours number, and the team’s own list of warning signs.' },
    { id: 'follow', text: 'When the follow-up appointments are and who books them', note: 'If “someone will call you,” ask who and when.' },
    { id: 'escort', text: 'The named adult escort is here, with the car', note: 'Many hospitals will not release to a rideshare alone, the surgeon’s office can tell you theirs.' },
    { id: 'equip', text: 'Equipment is at home or in the car, walker, shower chair, whatever the team ordered' },
    { id: 'rx', text: 'Prescriptions are filled, or you know which pharmacy has them and its hours today' },
    { id: 'papers', text: 'The discharge papers are in the bag', note: 'Upload them in the portal once home, that is how the medication list gets built.' }
  ]},
  { id: 'equip', title: 'Equipment: rent, buy, or insurance', when: 'On the way home', lead: 'What the team ordered, and whether it fits through the door. Ask the case manager which of these insurance covers, most cover a walker and a commode, few cover a shower chair.', items: [
    { id: 'list', text: 'You have the list of equipment the team ordered, in writing', note: 'Walker, commode, shower chair, hospital bed, oxygen, whatever is on it.' },
    { id: 'who', text: 'You know who delivers each item, and when', note: 'The DME company’s name and number. Ask: “before we get home, or after?”' },
    { id: 'cover', text: 'You asked which items insurance covers and which you pay for', note: 'Ask whether a prescription is needed for it to be covered.' },
    { id: 'door', text: 'Doorway widths are measured, bathroom and bedroom', note: 'A standard walker needs about 24 inches; a wheelchair about 32. A tape measure tonight saves a return trip.' },
    { id: 'rent', text: 'For anything short-term, you priced renting against buying', note: 'A shower chair is often cheaper to buy. A hospital bed is almost always rented.' },
    { id: 'lend', text: 'You asked the church, the neighbors, or a loan closet before buying', note: 'Many towns have a medical equipment loan closet. Ask the coordinator.' },
    { id: 'try', text: 'Somebody has tried the equipment in the actual bathroom', note: 'Shower chairs slide on some tubs. Raised seats do not fit every toilet.' },
  ]},
  { id: 'landing', title: 'The landing zone at home', when: 'Home', lead: 'One spot in the house where everything lives. Set it up before the car pulls in.', fridge: true, items: [
    { id: 'spot', text: 'One table or counter: medications, the notebook, the discharge papers, a charger' },
    { id: 'sheet', text: 'The one-page schedule and the who-to-call list on the fridge', note: 'Print the fridge sheet from this page.' },
    { id: 'bed', text: 'The bed or recliner is set up where the team said, propped up, on the right floor' },
    { id: 'path', text: 'Throw rugs up, night lights on, a clear path to the bathroom' },
    { id: 'bath', text: 'Shower chair, grab bars or a raised seat in place, if ordered' },
    { id: 'kitchen', text: 'Easy food for three days and water within reach' },
    { id: 'upload', text: 'Discharge papers uploaded in the portal', note: 'Under Documents. Your coordinator builds the medication list from them.' },
    { id: 'first', text: 'Someone is in the house the first night, if the team said so' }
  ]}
];

module.exports = { CHECKLISTS };
