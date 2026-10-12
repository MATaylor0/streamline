import type { Executor } from '../core/executor.js';
import type { Actor } from '../core/operation.js';

/**
 * Demo content for evaluation environments. Everything is created through the
 * executor (the "system path"), exactly as the UI, API or an AI agent would.
 */

type Step = [key: string, type: string, label: string, team: string | null, extra?: { role?: string; systems?: string[]; risks?: string[]; controls?: string[]; desc?: string; minutes?: number; link?: string; agent?: string; level?: 'assisted' | 'supervised' | 'autonomous'; oversight?: string }];
type Flow = [from: string, to: string, label?: string];

interface ProcessSpec {
  key: string;
  name: string;
  category: string;
  owner: string;
  summary: string;
  tags: string[];
  publish: boolean;
  steps: Step[];
  flows: Flow[];
}

export async function seedDemoData(executor: Executor, actor: Actor): Promise<void> {
  const meta = { channel: 'system' as const };
  const run = <T>(op: string, input: unknown) => executor.execute<T>(op, input, actor, meta);

  await run('settings.update', { organizationName: 'Acme Corporation' });

  const teamSpecs: Array<[string, string, string]> = [
    ['Operations', 'Operations', 'Business units that request goods and services'],
    ['Procurement', 'Finance', 'Sourcing, supplier management and purchasing'],
    ['Accounts Payable', 'Finance', 'Supplier invoice processing and payments'],
    ['Financial Control', 'Finance', 'Controllership, reconciliations and reporting'],
    ['Treasury', 'Finance', 'Cash management and payment execution'],
    ['Compliance', 'Legal & Risk', 'Sanctions, KYC and regulatory compliance'],
    ['People Team', 'HR', 'Recruiting, onboarding and employee lifecycle'],
    ['IT Service Desk', 'Technology', 'Access provisioning and end-user support'],
    ['Sales', 'Commercial', 'Customer acquisition and order capture'],
    ['Warehouse', 'Operations', 'Fulfilment, picking, packing and shipping'],
    ['Customer Service', 'Commercial', 'Customer enquiries and complaints'],
  ];
  const teams: Record<string, string> = {};
  for (const [name, department, description] of teamSpecs) {
    teams[name] = (await run<{ id: string }>('team.create', { name, department, description })).id;
  }

  const systemSpecs: Array<[string, string, string, string]> = [
    ['SAP S/4HANA', 'SAP', 'ERP', 'critical'],
    ['Coupa', 'Coupa', 'Procurement', 'high'],
    ['ServiceNow', 'ServiceNow', 'ITSM', 'high'],
    ['Workday', 'Workday', 'HRIS', 'high'],
    ['Salesforce', 'Salesforce', 'CRM', 'high'],
    ['DocuSign', 'DocuSign', 'E-signature', 'medium'],
    ['Bank Portal', 'Global Bank', 'Banking', 'critical'],
    ['Okta', 'Okta', 'Identity', 'critical'],
    ['Zendesk', 'Zendesk', 'Customer support', 'medium'],
  ];
  const systems: Record<string, string> = {};
  for (const [name, vendor, category, criticality] of systemSpecs) {
    systems[name] = (await run<{ id: string }>('system.create', { name, vendor, category, criticality, description: `${category} platform` })).id;
  }

  const controlSpecs: Array<[string, string, string, string, string, string]> = [
    ['PO approval per delegation of authority', 'preventive', 'it_dependent', 'Per transaction', 'effective', 'Procurement'],
    ['Three-way match (PO / receipt / invoice)', 'preventive', 'automated', 'Per transaction', 'effective', 'Accounts Payable'],
    ['Vendor master change review', 'detective', 'manual', 'Weekly', 'partially_effective', 'Financial Control'],
    ['Sanctions screening of new suppliers', 'preventive', 'automated', 'Per transaction', 'effective', 'Compliance'],
    ['Dual authorisation of payment runs', 'preventive', 'it_dependent', 'Per payment run', 'effective', 'Treasury'],
    ['Access provisioning approval', 'preventive', 'it_dependent', 'Per request', 'not_tested', 'IT Service Desk'],
    ['Credit limit check on order entry', 'preventive', 'automated', 'Per transaction', 'effective', 'Sales'],
    ['Balance sheet reconciliation sign-off', 'detective', 'manual', 'Monthly', 'effective', 'Financial Control'],
  ];
  const controls: Record<string, string> = {};
  for (const [name, controlType, nature, frequency, effectiveness, owner] of controlSpecs) {
    controls[name] = (await run<{ id: string }>('control.create', { name, controlType, nature, frequency, effectiveness, ownerTeamId: teams[owner] })).id;
  }

  const riskSpecs: Array<[string, string, number, number, string[]]> = [
    ['Unauthorised purchases', 'Spend management', 3, 4, ['PO approval per delegation of authority']],
    ['Duplicate or erroneous invoice payment', 'Financial loss', 3, 4, ['Three-way match (PO / receipt / invoice)']],
    ['Fraudulent vendor bank detail change', 'Fraud', 2, 5, ['Vendor master change review']],
    ['Engaging a sanctioned supplier', 'Regulatory', 2, 5, ['Sanctions screening of new suppliers']],
    ['Unauthorised payment release', 'Fraud', 2, 5, ['Dual authorisation of payment runs']],
    ['Excessive system access for new joiners', 'Information security', 3, 3, ['Access provisioning approval']],
    ['Bad debt from customers over credit limit', 'Credit', 3, 3, ['Credit limit check on order entry']],
    ['Misstatement in financial statements', 'Financial reporting', 2, 5, ['Balance sheet reconciliation sign-off']],
    ['Complaints not resolved within SLA', 'Customer', 4, 2, []],
  ];
  const risks: Record<string, string> = {};
  for (const [title, category, likelihood, impact, ctl] of riskSpecs) {
    risks[title] = (await run<{ id: string }>('risk.create', { title, category, likelihood, impact, controlIds: ctl.map((c) => controls[c]) })).id;
  }

  const specs: ProcessSpec[] = [
    {
      key: 'vendor',
      name: 'Supplier Onboarding',
      category: 'Finance / Procure to Pay',
      owner: 'Procurement',
      summary: 'Assess, approve and set up new suppliers in the vendor master.',
      tags: ['procure-to-pay', 'SOX'],
      publish: true,
      steps: [
        ['s', 'start', 'Supplier needed', 'Operations'],
        ['req', 'task', 'Submit supplier request', 'Operations', { role: 'Requester', systems: ['Coupa'], minutes: 15 }],
        ['due', 'task', 'Collect supplier documentation', 'Procurement', { role: 'Buyer', systems: ['Coupa', 'DocuSign'], minutes: 60 }],
        ['scr', 'task', 'Sanctions & KYC screening', 'Compliance', { systems: ['Coupa'], risks: ['Engaging a sanctioned supplier'], controls: ['Sanctions screening of new suppliers'], minutes: 30, agent: 'Sanctions Screening Assistant', level: 'assisted', oversight: 'Compliance analyst reviews every match and makes the final decision' }],
        ['ok', 'decision', 'Screening passed?', null],
        ['rej', 'end', 'Supplier rejected', 'Procurement'],
        ['setup', 'task', 'Create vendor master record', 'Financial Control', { role: 'Master Data Analyst', systems: ['SAP S/4HANA'], risks: ['Fraudulent vendor bank detail change'], controls: ['Vendor master change review'], minutes: 20 }],
        ['e', 'end', 'Supplier active', 'Procurement'],
      ],
      flows: [['s', 'req'], ['req', 'due'], ['due', 'scr'], ['scr', 'ok'], ['ok', 'setup', 'Yes'], ['ok', 'rej', 'No'], ['setup', 'e']],
    },
    {
      key: 'p2p',
      name: 'Purchase Requisition to Purchase Order',
      category: 'Finance / Procure to Pay',
      owner: 'Procurement',
      summary: 'Raise, approve and convert purchase requisitions into purchase orders.',
      tags: ['procure-to-pay', 'SOX'],
      publish: true,
      steps: [
        ['s', 'start', 'Need identified', 'Operations'],
        ['pr', 'task', 'Create purchase requisition', 'Operations', { role: 'Requester', systems: ['Coupa'], minutes: 10 }],
        ['appr', 'task', 'Approve requisition', 'Operations', { role: 'Budget Holder', systems: ['Coupa'], risks: ['Unauthorised purchases'], controls: ['PO approval per delegation of authority'], minutes: 5 }],
        ['new', 'decision', 'Existing supplier?', null],
        ['onb', 'subprocess', 'Supplier Onboarding', 'Procurement', { link: 'vendor' }],
        ['src', 'task', 'Source & negotiate', 'Procurement', { role: 'Buyer', minutes: 240 }],
        ['po', 'task', 'Issue purchase order', 'Procurement', { role: 'Buyer', systems: ['Coupa', 'SAP S/4HANA'], minutes: 15 }],
        ['e', 'end', 'PO sent to supplier', 'Procurement'],
      ],
      flows: [['s', 'pr'], ['pr', 'appr'], ['appr', 'new'], ['new', 'src', 'Yes'], ['new', 'onb', 'No'], ['onb', 'src'], ['src', 'po'], ['po', 'e']],
    },
    {
      key: 'ap',
      name: 'Supplier Invoice to Payment',
      category: 'Finance / Procure to Pay',
      owner: 'Accounts Payable',
      summary: 'Receive, validate, approve and pay supplier invoices.',
      tags: ['procure-to-pay', 'SOX', 'cash'],
      publish: true,
      steps: [
        ['s', 'start', 'Invoice received', 'Accounts Payable'],
        ['cap', 'task', 'Capture invoice', 'Accounts Payable', { role: 'AP Clerk', systems: ['Coupa'], minutes: 5, agent: 'Invoice Capture Agent', level: 'autonomous', oversight: 'Low-confidence extractions go to the AP Clerk queue; AP Lead samples 5% of captures daily' }],
        ['gr', 'task', 'Confirm goods receipt', 'Operations', { role: 'Requester', systems: ['Coupa'], minutes: 5 }],
        ['match', 'decision', 'Three-way match OK?', null, { risks: ['Duplicate or erroneous invoice payment'], controls: ['Three-way match (PO / receipt / invoice)'] }],
        ['exc', 'task', 'Resolve exception with buyer', 'Procurement', { role: 'Buyer', minutes: 45 }],
        ['post', 'task', 'Post invoice', 'Accounts Payable', { role: 'AP Clerk', systems: ['SAP S/4HANA'], minutes: 5, agent: 'Invoice Capture Agent', level: 'supervised', oversight: 'AP Clerk approves each proposed posting before release' }],
        ['run', 'task', 'Propose payment run', 'Accounts Payable', { role: 'AP Lead', systems: ['SAP S/4HANA'], minutes: 30 }],
        ['rel', 'task', 'Approve & release payments', 'Treasury', { role: 'Treasury Manager', systems: ['Bank Portal'], risks: ['Unauthorised payment release'], controls: ['Dual authorisation of payment runs'], minutes: 20 }],
        ['e', 'end', 'Supplier paid', 'Treasury'],
      ],
      flows: [['s', 'cap'], ['cap', 'gr'], ['gr', 'match'], ['match', 'post', 'Matched'], ['match', 'exc', 'Mismatch'], ['exc', 'match'], ['post', 'run'], ['run', 'rel'], ['rel', 'e']],
    },
    {
      key: 'close',
      name: 'Month-End Close',
      category: 'Finance / Record to Report',
      owner: 'Financial Control',
      summary: 'Close the books and produce monthly management accounts.',
      tags: ['record-to-report', 'SOX'],
      publish: false,
      steps: [
        ['s', 'start', 'Period end', 'Financial Control'],
        ['ap', 'task', 'AP cut-off & accruals', 'Accounts Payable', { systems: ['SAP S/4HANA'], minutes: 240 }],
        ['rec', 'task', 'Balance sheet reconciliations', 'Financial Control', { systems: ['SAP S/4HANA'], risks: ['Misstatement in financial statements'], controls: ['Balance sheet reconciliation sign-off'], minutes: 960 }],
        ['cash', 'task', 'Bank reconciliation', 'Treasury', { systems: ['Bank Portal', 'SAP S/4HANA'], minutes: 120 }],
        ['rep', 'task', 'Prepare management accounts', 'Financial Control', { minutes: 480 }],
        ['e', 'end', 'Books closed', 'Financial Control'],
      ],
      flows: [['s', 'ap'], ['s', 'cash'], ['ap', 'rec'], ['cash', 'rec'], ['rec', 'rep'], ['rep', 'e']],
    },
    {
      key: 'onboard',
      name: 'Employee Onboarding',
      category: 'People / Hire to Retire',
      owner: 'People Team',
      summary: 'Prepare everything a new joiner needs for a productive first day.',
      tags: ['hire-to-retire', 'access-management'],
      publish: true,
      steps: [
        ['s', 'start', 'Offer accepted', 'People Team'],
        ['hr', 'task', 'Create worker record', 'People Team', { role: 'HR Coordinator', systems: ['Workday'], minutes: 20 }],
        ['ticket', 'task', 'Raise IT onboarding ticket', 'People Team', { systems: ['ServiceNow'], minutes: 5 }],
        ['acc', 'task', 'Provision accounts & access', 'IT Service Desk', { systems: ['Okta', 'ServiceNow'], risks: ['Excessive system access for new joiners'], controls: ['Access provisioning approval'], minutes: 60, agent: 'IT Onboarding Agent', level: 'supervised', oversight: 'Service desk analyst approves the proposed access bundle; hiring manager approves privileged access' }],
        ['hw', 'task', 'Prepare laptop', 'IT Service Desk', { minutes: 90 }],
        ['day1', 'task', 'Day-one induction', 'People Team', { minutes: 240 }],
        ['e', 'end', 'Employee productive', 'Operations'],
      ],
      flows: [['s', 'hr'], ['hr', 'ticket'], ['ticket', 'acc'], ['ticket', 'hw'], ['acc', 'day1'], ['hw', 'day1'], ['day1', 'e']],
    },
    {
      key: 'o2c',
      name: 'Order to Cash',
      category: 'Commercial / Order to Cash',
      owner: 'Sales',
      summary: 'Capture customer orders, fulfil them and collect cash.',
      tags: ['order-to-cash', 'cash'],
      publish: true,
      steps: [
        ['s', 'start', 'Customer order', 'Sales'],
        ['enter', 'task', 'Enter sales order', 'Sales', { systems: ['Salesforce', 'SAP S/4HANA'], minutes: 10 }],
        ['credit', 'decision', 'Within credit limit?', null, { risks: ['Bad debt from customers over credit limit'], controls: ['Credit limit check on order entry'] }],
        ['hold', 'task', 'Credit review', 'Financial Control', { minutes: 60 }],
        ['pick', 'task', 'Pick, pack & ship', 'Warehouse', { systems: ['SAP S/4HANA'], minutes: 45 }],
        ['inv', 'task', 'Issue customer invoice', 'Financial Control', { systems: ['SAP S/4HANA'], minutes: 5 }],
        ['cash', 'task', 'Apply cash receipt', 'Treasury', { systems: ['Bank Portal', 'SAP S/4HANA'], minutes: 10 }],
        ['e', 'end', 'Cash collected', 'Treasury'],
      ],
      flows: [['s', 'enter'], ['enter', 'credit'], ['credit', 'pick', 'Yes'], ['credit', 'hold', 'No'], ['hold', 'pick', 'Released'], ['pick', 'inv'], ['inv', 'cash'], ['cash', 'e']],
    },
    {
      key: 'complaint',
      name: 'Customer Complaint Handling',
      category: 'Commercial / Customer Service',
      owner: 'Customer Service',
      summary: 'Log, investigate and resolve customer complaints within SLA.',
      tags: ['customer'],
      publish: false,
      steps: [
        ['s', 'start', 'Complaint received', 'Customer Service'],
        ['log', 'task', 'Log complaint', 'Customer Service', { systems: ['Zendesk'], risks: ['Complaints not resolved within SLA'], minutes: 10 }],
        ['tri', 'decision', 'Delivery issue?', null],
        ['wh', 'task', 'Investigate shipment', 'Warehouse', { systems: ['SAP S/4HANA'], minutes: 60 }],
        ['sales', 'task', 'Agree commercial remedy', 'Sales', { systems: ['Salesforce'], minutes: 30 }],
        ['resp', 'task', 'Respond to customer', 'Customer Service', { systems: ['Zendesk'], minutes: 15, agent: 'Customer Reply Drafting Agent', level: 'assisted', oversight: 'Customer service agent edits and sends every reply' }],
        ['e', 'end', 'Complaint closed', 'Customer Service'],
      ],
      flows: [['s', 'log'], ['log', 'tri'], ['tri', 'wh', 'Yes'], ['tri', 'sales', 'No'], ['wh', 'resp'], ['sales', 'resp'], ['resp', 'e']],
    },
  ];

  // AI agents that some steps are delegated to.
  const agentSpecs: Array<{ name: string; description: string; provider: string; model?: string; platform: string; owner: string; status: string; riskTier: string; dataAccess: string; systems: string[] }> = [
    {
      name: 'Invoice Capture Agent',
      description: 'Reads supplier invoices (PDF/e-mail), extracts header and line data, matches to POs and prepares postings.',
      provider: 'Anthropic',
      model: 'Claude',
      platform: 'Claude Agent SDK on internal Kubernetes',
      owner: 'Accounts Payable',
      status: 'production',
      riskTier: 'limited',
      dataAccess: 'Supplier invoices and PO data (Confidential). Read/write in Coupa; post-only role in SAP.',
      systems: ['Coupa', 'SAP S/4HANA'],
    },
    {
      name: 'Sanctions Screening Assistant',
      description: 'Screens new suppliers against sanctions and adverse-media sources and drafts a risk summary for the analyst.',
      provider: 'In-house',
      platform: 'Compliance analytics platform',
      owner: 'Compliance',
      status: 'pilot',
      riskTier: 'high',
      dataAccess: 'Supplier KYC records (Restricted). Read-only.',
      systems: ['Coupa'],
    },
    {
      name: 'IT Onboarding Agent',
      description: 'Builds the access bundle for a new joiner from their role and raises provisioning requests.',
      provider: 'Anthropic',
      model: 'Claude',
      platform: 'ServiceNow + MCP',
      owner: 'IT Service Desk',
      status: 'production',
      riskTier: 'limited',
      dataAccess: 'Worker profile (Internal). Can request, not grant, access.',
      systems: ['ServiceNow', 'Okta', 'Workday'],
    },
    {
      name: 'Customer Reply Drafting Agent',
      description: 'Drafts empathetic replies to customer complaints from the case history for an agent to edit and send.',
      provider: 'Anthropic',
      model: 'Claude',
      platform: 'Zendesk app',
      owner: 'Customer Service',
      status: 'pilot',
      riskTier: 'minimal',
      dataAccess: 'Customer case history (Confidential). No send permission.',
      systems: ['Zendesk'],
    },
  ];
  const agents: Record<string, string> = {};
  for (const a of agentSpecs) {
    agents[a.name] = (
      await run<{ id: string }>('agent.create', {
        name: a.name,
        description: a.description,
        provider: a.provider,
        model: a.model ?? null,
        platform: a.platform,
        ownerTeamId: teams[a.owner],
        status: a.status,
        riskTier: a.riskTier,
        dataAccess: a.dataAccess,
        systemIds: a.systems.map((x) => systems[x]),
      })
    ).id;
  }

  const created: Record<string, string> = {};
  for (const spec of specs) {
    const nodes = spec.steps.map(([id, type, label, team, x]) => ({
      id,
      type,
      label,
      description: x?.desc ?? '',
      teamId: team ? teams[team] : null,
      actorRole: x?.role ?? null,
      durationMinutes: x?.minutes ?? null,
      linkedProcessId: x?.link ? created[x.link] : null,
      systemIds: (x?.systems ?? []).map((s) => systems[s]),
      riskIds: (x?.risks ?? []).map((r) => risks[r]),
      controlIds: (x?.controls ?? []).map((c) => controls[c]),
      agentId: x?.agent ? agents[x.agent] : null,
      automationLevel: x?.level ?? 'manual',
      oversight: x?.oversight ?? null,
    }));
    const edges = spec.flows.map(([source, target, label]) => ({ source, target, label: label ?? null }));
    const p = await run<{ id: string }>('process.create', {
      name: spec.name,
      summary: spec.summary,
      category: spec.category,
      ownerTeamId: teams[spec.owner],
      tags: spec.tags,
      nodes,
      edges,
    });
    created[spec.key] = p.id;
    if (spec.publish) {
      await run('process.submitForReview', { id: p.id });
      await run('process.publish', { id: p.id, changeNote: 'Initial version' });
    }
  }
}
