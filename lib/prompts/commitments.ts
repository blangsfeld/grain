/**
 * COMMITMENTS pass — who owes what to whom, by when, for which life domain.
 * Produces individual addressable commitment atoms for Buddy and for the
 * promote-to-Notion flow (kept list).
 *
 * Upgrade 2026-04-16: linguistic markers, life-domain category, company
 * attribution rules, named-person heuristics. Replaces the co-work scheduled
 * task that previously did this separately.
 */

export function buildCommitmentsPrompt(transcript: string, title: string): string {
  return `You are extracting commitments and follow-ups from a meeting transcript for
Ben Langsfeld's executive assistant. Be precise, not noisy. Every row you emit
will be classified, filtered, and potentially surfaced to Ben. Noise costs him
trust in the pipeline.

## TYPE — use linguistic markers

commitment — firm first-person obligation from an identifiable owner
  "I'll send the deck by Friday"
  "I'm going to handle the Verizon intro"
  "Daniell will call the contractor tomorrow"

follow_up — softer, team-level, conditional, or exploratory
  "we should think about that"
  "let's look into whether..."
  "someone should reach out to..."
  "maybe we could..."

If the speaker is NOT committing their own time/effort, and no specific
owner was named, it's a follow_up — even when phrased with firm verbs.

## CATEGORY — Ben's life domain (required, pick exactly one)

Personal      — Ben's own health, hobbies, family, household admin not tied to a home
Dunbar        — 67 Dunbar Rd (country home): contractors, upkeep, furnishings,
                deliveries, utilities, anything physical at that property
Prospect      — 442 Prospect (Brooklyn home): contractors, upkeep, groceries,
                services, anything physical at that property
Expenses      — reimbursements, invoices, receipts, reconciliations, accounting
Travel        — flights, hotels, itineraries for trips Ben is taking
Medical       — appointments, prescriptions, health admin for Ben
Residence     — network-level work: Ben's CCO role, cross-company coordination,
                Residence-branded initiatives, Forward Plan, AI transformation
                positioning, network-wide meeting formats
BUCK          — work that serves BUCK as the entity
Wild          — work that serves Wild as the entity
Giant Ant     — work that serves Giant Ant as the entity
Part+Sum      — work that serves Part+Sum as the entity
VTPro         — work that serves VTPro as the entity
Its Nice That — work that serves It's Nice That as the entity (no apostrophe in value)
Ok Cool       — work that serves Ok Cool as the entity
CLIP          — work that serves CLIP / IYC as the entity
Other         — falls outside all of the above

## COMPANY — serves which entity, not who made it

Attribute by which entity the work serves, not whose mouth it came out of.
Network-level coordination among Residence companies = Residence, even when
BUCK or Wild people are present. A BUCK person committing to update the
Forward Plan is Residence work.

Named-person heuristics when company is unstated:
  Ryan Honey, Madison Wharton, Wade Milne, Orion Tait → Residence
  Daniell Phillips, Ryan Castaldo, Julian McBride,
    Tarley Jordan, Jan Jensen, Lexxi Ramakers, Emily Rickard → Residence
  Nick Carmen, Monica Lynn, Michelle Fox, Kevin Walker,
    Yker Moreno, Max Vogel → BUCK
  Thomas Ragger (Rags), Felix Häusler, Claire M, Matthias Mentasti → Wild
  Jay Grandin, Leah Nelson → Giant Ant

Use first-name-only when that's all the transcript provides and it uniquely
resolves. If a first name is ambiguous (multiple Ryans), emit null for
company unless other context disambiguates.

## PERSON — name, not role

Always a proper name ("Daniell Phillips" or "Daniell"), never a role
("the producer", "her team"). Null if no name is attached.

## STATEMENT — complete and self-contained

Rewrite into a crisp action that stands alone without the transcript. Include
the actor, the action, the object, and the timing if stated.
  Bad:  "he'll send it over"
  Good: "Daniell will send Ben the Verizon deck by Friday"

## CONVICTION

firm         — specific owner, specific action, specific timeline, no hedging
soft         — intent stated, details vague ("I'll look into that this week")
aspirational — "we should", "someone could", no owner or timeline attached

## WHAT TO SKIP

Do NOT emit rows for:
  - Pure calendaring ("block calendar time", "meet at 3pm")
  - Trivial logistics ("take the call from the car")
  - When/where-only statements with no substantive action
  - Meet-ups and work sessions mislabeled as business commitments
  - Rehashing what someone already did — commitments are forward-looking

If nothing substantive was committed or flagged as a follow-up, return [].

## OUTPUT

JSON array only. No commentary, no code fences.

[
  {
    "statement": "self-contained action",
    "type": "commitment | follow_up",
    "person": "name or null",
    "company": "Residence | BUCK | Wild | Giant Ant | Part+Sum | VTPro | Its Nice That | Ok Cool | CLIP | external | null",
    "project": "project name or null",
    "category": "Personal | Dunbar | Prospect | Expenses | Travel | Medical | Residence | BUCK | Wild | Giant Ant | Part+Sum | VTPro | Its Nice That | Ok Cool | CLIP | Other",
    "due_date": "YYYY-MM-DD or null",
    "conviction": "firm | soft | aspirational"
  }
]

## MEETING

Title: ${title}

${transcript}`;
}

export const COMMITMENTS_MAX_TOKENS = 2000;
