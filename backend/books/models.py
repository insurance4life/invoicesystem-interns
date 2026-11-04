"""OpenBooks schema as Django models (PostgreSQL).

Column names/types mirror the original SQLite schema exactly so the SQL in books/core and
books/modules works unchanged:  TEXT -> TextField, INTEGER -> IntegerField (0/1 flags stay ints),
REAL -> FloatField (double precision), dates stay 'YYYY-MM-DD' text, created_at is UTC text
'YYYY-MM-DD HH:MM:SS'. Defaults are database defaults (db_default) because most writes use SQL.
ON DELETE CASCADE references use models.DB_CASCADE (enforced by PostgreSQL); other references
are plain integer columns, as they were unenforced or checked in code before.
"""
from django.db import models


class UtcNowText(models.Func):
    """DB default: current UTC time as 'YYYY-MM-DD HH:MM:SS' text (SQLite datetime('now'))."""
    template = "to_char((now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS')"
    output_field = models.TextField()


def T(default=None, null=True):
    return models.TextField(null=null, db_default=default) if default is not None else models.TextField(null=null)


def I(default=None, null=True):
    return models.IntegerField(null=null, db_default=default) if default is not None else models.IntegerField(null=null)


def R(default=None, null=True):
    return models.FloatField(null=null, db_default=default) if default is not None else models.FloatField(null=null)


def created():
    return models.TextField(null=True, db_default=UtcNowText())


def fk(model, null=False):
    return models.ForeignKey(model, on_delete=models.DB_CASCADE, related_name='+', null=null)


def ORG():
    return fk('Org')


# ---------------------------------------------------------------- core

class User(models.Model):
    name = T(null=False)
    email = T(null=False)
    password_hash = T(null=False)
    default_org_id = I()
    theme = T('light')
    created_at = created()

    class Meta:
        db_table = 'users'
        constraints = [models.UniqueConstraint(models.functions.Lower('email'), name='users_email_nocase_uniq')]


class Org(models.Model):
    name = T(null=False)
    industry = T()
    country = T('India')
    state = T()
    currency = T('INR')
    fiscal_year_start = I(4)
    timezone = T('Asia/Kolkata')
    date_format = T('dd/MM/yyyy')
    gstin = T()
    gst_enabled = I(1)
    address = T()
    phone = T()
    email = T()
    website = T()
    logo = T()
    settings = T('{}')
    lock_date = T()
    created_at = created()

    class Meta:
        db_table = 'orgs'


class Role(models.Model):
    org = ORG()
    name = T(null=False)
    description = T()
    permissions = T('{}')
    is_system = I(0)

    class Meta:
        db_table = 'roles'


class OrgUser(models.Model):
    org = ORG()
    user = fk('User')
    role_id = I()
    status = T('active')

    class Meta:
        db_table = 'org_users'
        constraints = [models.UniqueConstraint(fields=['org', 'user'], name='org_users_org_user_uniq')]


class Currency(models.Model):
    org = ORG()
    code = T(null=False)
    symbol = T()
    name = T()
    exchange_rate = R(1)
    is_base = I(0)

    class Meta:
        db_table = 'currencies'
        constraints = [models.UniqueConstraint(fields=['org', 'code'], name='currencies_org_code_uniq')]


class PaymentTerm(models.Model):
    org = ORG()
    name = T(null=False)
    days = I(0)
    type = T('net')
    is_default = I(0)

    class Meta:
        db_table = 'payment_terms'


class Tax(models.Model):
    org = ORG()
    name = T(null=False)
    rate = R(0)
    kind = T('simple')
    group_ids = T()
    is_active = I(1)

    class Meta:
        db_table = 'taxes'


class Account(models.Model):
    org = ORG()
    code = T()
    name = T(null=False)
    type = T(null=False)
    parent_id = I()
    description = T()
    is_system = I(0)
    system_code = T()
    is_active = I(1)
    currency = T()
    watchlist = I(0)
    bank_name = T()
    account_number = T()
    ifsc = T()
    created_at = created()

    class Meta:
        db_table = 'accounts'
        indexes = [models.Index(fields=['org', 'system_code'], name='ix_accounts_org')]


class Contact(models.Model):
    org = ORG()
    type = T(null=False)
    customer_type = T('business')
    display_name = T(null=False)
    company_name = T()
    salutation = T()
    first_name = T()
    last_name = T()
    email = T()
    phone = T()
    mobile = T()
    website = T()
    currency = T()
    payment_term_id = I()
    gst_treatment = T()
    gstin = T()
    pan = T()
    place_of_supply = T()
    tax_id = I()
    billing_address = T()
    shipping_address = T()
    contact_persons = T()
    notes = T()
    credit_limit = R()
    price_list_id = I()
    portal_enabled = I(0)
    portal_token = T()
    reminders_enabled = I(1)
    linked_contact_id = I()
    custom_fields = T()
    is_active = I(1)
    created_at = created()

    class Meta:
        db_table = 'contacts'
        indexes = [models.Index(fields=['org', 'type'], name='ix_contacts_org')]


class Item(models.Model):
    org = ORG()
    type = T('goods')
    name = T(null=False)
    sku = T()
    unit = T()
    hsn_sac = T()
    description = T()
    selling_price = R(0)
    sales_account_id = I()
    tax_id = I()
    purchase_price = R(0)
    purchase_account_id = I()
    purchase_description = T()
    purchase_tax_id = I()
    track_inventory = I(0)
    inventory_account_id = I()
    opening_stock = R(0)
    opening_stock_rate = R(0)
    reorder_level = R(0)
    is_sellable = I(1)
    is_purchasable = I(1)
    image = T()
    custom_fields = T()
    is_active = I(1)
    created_at = created()

    class Meta:
        db_table = 'items'


class StockMove(models.Model):
    org = ORG()
    item = fk('Item')
    date = T(null=False)
    qty = R(null=False)
    rate = R(0)
    value = R(0)
    src_type = T()
    src_id = I()

    class Meta:
        db_table = 'stock_moves'
        indexes = [models.Index(fields=['item', 'date'], name='ix_stock_item'),
                   models.Index(fields=['src_type', 'src_id'], name='ix_stock_src')]


class Document(models.Model):
    org = ORG()
    doc_type = T(null=False)
    number = T()
    reference = T()
    contact_id = I()
    date = T(null=False)
    due_date = T()
    payment_term_id = I()
    status = T('draft')
    currency = T()
    exchange_rate = R(1)
    place_of_supply = T()
    tax_inclusive = I(0)
    discount_type = T('percent')
    discount_value = R(0)
    discount_total = R(0)
    shipping = R(0)
    adjustment = R(0)
    adjustment_label = T()
    subtotal = R(0)
    tax_total = R(0)
    taxes = T()
    total = R(0)
    balance = R(0)
    write_off = R(0)
    notes = T()
    terms = T()
    billing_address = T()
    shipping_address = T()
    salesperson = T()
    project_id = I()
    source_doc_id = I()
    profile_id = I()
    recurrence = T()
    share_token = T()
    sent_at = T()
    approved_by = I()
    custom_fields = T()
    delivery_date = T()
    account_id = I()
    payment_mode = T()
    created_by = I()
    created_at = created()
    updated_at = created()

    class Meta:
        db_table = 'documents'
        indexes = [models.Index(fields=['org', 'doc_type', 'date'], name='ix_docs_org'),
                   models.Index(fields=['contact_id'], name='ix_docs_contact')]


class DocumentLine(models.Model):
    document = fk('Document')
    sort = I(0)
    item_id = I()
    account_id = I()
    name = T()
    description = T()
    quantity = R(1)
    unit = T()
    rate = R(0)
    discount = R(0)
    tax_id = I()
    hsn_sac = T()
    amount = R(0)
    taxable = R(0)
    tax_amount = R(0)
    tax_breakdown = T()
    src_type = T()
    src_id = I()
    customer_id = I()
    project_id = I()

    class Meta:
        db_table = 'document_lines'
        indexes = [models.Index(fields=['document'], name='ix_lines_doc')]


class Payment(models.Model):
    org = ORG()
    type = T(null=False)
    number = T()
    contact_id = I()
    date = T(null=False)
    amount = R(null=False)
    currency = T()
    exchange_rate = R(1)
    mode = T()
    account_id = I()
    reference = T()
    bank_charges = R(0)
    tds_amount = R(0)
    notes = T()
    is_online = I(0)
    created_by = I()
    created_at = created()

    class Meta:
        db_table = 'payments'


class PaymentAllocation(models.Model):
    payment = fk('Payment')
    document = fk('Document')
    amount = R(null=False)

    class Meta:
        db_table = 'payment_allocations'


class CreditApplication(models.Model):
    org = ORG()
    source_type = T(null=False)
    source_id = I(null=False)
    document = fk('Document')
    amount = R(null=False)
    date = T(null=False)

    class Meta:
        db_table = 'credit_applications'


class Refund(models.Model):
    org = ORG()
    source_type = T(null=False)
    source_id = I(null=False)
    date = T(null=False)
    amount = R(null=False)
    account_id = I()
    mode = T()
    reference = T()
    notes = T()

    class Meta:
        db_table = 'refunds'


class Expense(models.Model):
    org = ORG()
    date = T(null=False)
    account_id = I()
    paid_through_id = I()
    amount = R(0)
    tax_id = I()
    tax_inclusive = I(1)
    tax_amount = R(0)
    total = R(0)
    currency = T()
    exchange_rate = R(1)
    vendor_id = I()
    customer_id = I()
    project_id = I()
    is_billable = I(0)
    markup_percent = R(0)
    invoice_id = I()
    reference = T()
    notes = T()
    place_of_supply = T()
    hsn_sac = T()
    is_mileage = I(0)
    distance = R()
    mileage_rate = R()
    splits = T()
    recurrence = T()
    is_profile = I(0)
    profile_id = I()
    status = T('unbilled')
    created_by = I()
    created_at = created()

    class Meta:
        db_table = 'expenses'


class Journal(models.Model):
    org = ORG()
    number = T()
    date = T(null=False)
    reference = T()
    notes = T()
    status = T('published')
    journal_type = T('manual')
    currency = T()
    exchange_rate = R(1)
    recurrence = T()
    is_profile = I(0)
    profile_id = I()
    reverse_date = T()
    reversed_journal_id = I()
    total = R(0)
    created_by = I()
    created_at = created()

    class Meta:
        db_table = 'journals'


class JournalLine(models.Model):
    journal = fk('Journal')
    account_id = I(null=False)
    contact_id = I()
    description = T()
    debit = R(0)
    credit = R(0)

    class Meta:
        db_table = 'journal_lines'


class Ledger(models.Model):
    org = ORG()
    date = T(null=False)
    src_type = T(null=False)
    src_id = I(null=False)
    number = T()
    account_id = I(null=False)
    contact_id = I()
    debit = R(0)
    credit = R(0)
    description = T()
    reconciliation_id = I()
    created_at = created()

    class Meta:
        db_table = 'ledger'
        indexes = [models.Index(fields=['org', 'date'], name='ix_ledger_org_date'),
                   models.Index(fields=['account_id', 'date'], name='ix_ledger_account'),
                   models.Index(fields=['src_type', 'src_id'], name='ix_ledger_src')]


class File(models.Model):
    org = ORG()
    name = T(null=False)
    mime = T()
    size = I()
    path = T(null=False)
    entity_type = T()
    entity_id = I()
    folder = T('inbox')
    uploaded_by = I()
    created_at = created()

    class Meta:
        db_table = 'files'


class Activity(models.Model):
    org_id = I(null=False)
    user_id = I()
    entity_type = T()
    entity_id = I()
    action = T()
    detail = T()
    created_at = created()

    class Meta:
        db_table = 'activity'
        indexes = [models.Index(fields=['org_id', 'entity_type', 'entity_id'], name='ix_activity')]


class Comment(models.Model):
    org_id = I(null=False)
    entity_type = T()
    entity_id = I()
    user_id = I()
    author = T()
    text = T(null=False)
    created_at = created()

    class Meta:
        db_table = 'comments'


class Email(models.Model):
    org_id = I(null=False)
    to_addr = T()
    cc = T()
    subject = T()
    body = T()
    entity_type = T()
    entity_id = I()
    status = T('queued')
    error = T()
    sent_by = I()  # user who caused the send (None for jobs); used for the per-user hourly cap
    created_at = created()

    class Meta:
        db_table = 'emails'


class CustomField(models.Model):
    org = ORG()
    module = T(null=False)
    label = T(null=False)
    field_key = T(null=False)
    data_type = T('text')
    options = T()
    is_required = I(0)
    show_in_pdf = I(0)

    class Meta:
        db_table = 'custom_fields'


# ---------------------------------------------------------------- automation

class WorkflowRule(models.Model):
    org = ORG()
    name = T(null=False)
    module = T(null=False)
    doc_type = T()
    trigger = T('created', null=False)
    conditions = T('[]')
    actions = T('[]')
    is_active = I(1)
    created_at = created()

    class Meta:
        db_table = 'workflow_rules'


class WorkflowLog(models.Model):
    org = ORG()
    rule_id = I()
    entity_type = T()
    entity_id = I()
    action_type = T()
    status = T()
    message = T()
    created_at = created()

    class Meta:
        db_table = 'workflow_logs'
        indexes = [models.Index(fields=['org', 'rule_id'], name='ix_workflow_logs')]


class IncomingWebhook(models.Model):
    org = ORG()
    name = T(null=False)
    token = models.TextField(unique=True)
    module = T()
    created_at = created()

    class Meta:
        db_table = 'incoming_webhooks'


# ---------------------------------------------------------------- banking

class BankStatementLine(models.Model):
    org = ORG()
    account_id = I(null=False)
    date = T(null=False)
    description = T()
    reference = T()
    payee = T()
    amount = R(null=False)
    balance = R()
    status = T('uncategorized')
    matched_type = T()
    matched_id = I()
    rule_id = I()
    suggestion = T()
    import_batch = T()
    created_at = created()

    class Meta:
        db_table = 'bank_statement_lines'
        indexes = [models.Index(fields=['account_id', 'status', 'date'], name='ix_bsl_account'),
                   models.Index(fields=['matched_type', 'matched_id'], name='ix_bsl_match')]


class BankTxn(models.Model):
    org = ORG()
    account_id = I(null=False)
    date = T(null=False)
    txn_type = T(null=False)
    direction = T('in', null=False)
    amount = R(null=False)
    offset_account_id = I()
    to_account_id = I()
    contact_id = I()
    reference = T()
    description = T()
    splits = T()
    statement_line_id = I()
    created_by = I()
    created_at = created()

    class Meta:
        db_table = 'bank_txns'
        indexes = [models.Index(fields=['org', 'account_id', 'date'], name='ix_btx_account')]


class BankDepositPayment(models.Model):
    org = ORG()
    bank_txn = fk('BankTxn')
    payment_id = I(null=False)
    amount = R()

    class Meta:
        db_table = 'bank_deposit_payments'


class BankRule(models.Model):
    org = ORG()
    account_id = I()
    name = T(null=False)
    priority = I(0)
    apply_to = T('both')
    conditions = T('[]')
    match = T('all')
    action = T('{}')
    is_active = I(1)
    created_at = created()

    class Meta:
        db_table = 'bank_rules'


class Reconciliation(models.Model):
    org = ORG()
    account_id = I(null=False)
    start_date = T()
    end_date = T(null=False)
    opening_balance = R(0)
    closing_balance = R(0)
    status = T('in_progress')
    completed_at = T()
    created_at = created()

    class Meta:
        db_table = 'reconciliations'


# ---------------------------------------------------------------- accountant

class Budget(models.Model):
    org = ORG()
    name = T(null=False)
    fiscal_year = I(null=False)
    period = T('monthly', null=False)
    lines = T('{}')
    created_at = created()

    class Meta:
        db_table = 'budgets'
        indexes = [models.Index(fields=['org', 'fiscal_year'], name='ix_budgets_org')]


class FixedAsset(models.Model):
    org = ORG()
    name = T(null=False)
    asset_number = T()
    asset_account_id = I()
    expense_account_id = I()
    accumulated_account_id = I()
    purchase_date = T(null=False)
    purchase_value = R(0, null=False)
    salvage_value = R(0)
    useful_life_months = I()
    method = T('straight_line')
    dep_rate = R(0)
    depreciation_start = T()
    status = T('draft')
    disposed_date = T()
    disposal_amount = R()
    disposal_account_id = I()
    notes = T()

    class Meta:
        db_table = 'fixed_assets'


class FixedAssetDepreciation(models.Model):
    asset = fk('FixedAsset')
    org = ORG()
    period_end = T(null=False)
    amount = R(null=False)

    class Meta:
        db_table = 'fixed_asset_depreciation'
        indexes = [models.Index(fields=['asset', 'period_end'], name='ix_fa_dep')]


class CurrencyAdjustment(models.Model):
    org = ORG()
    date = T(null=False)
    currency = T(null=False)
    rate = R(null=False)
    amount = R(0)
    notes = T()
    created_at = created()

    class Meta:
        db_table = 'currency_adjustments'
        indexes = [models.Index(fields=['org', 'currency', 'date'], name='ix_fxadj_org')]


# ---------------------------------------------------------------- inventory

class InventoryAdjustment(models.Model):
    org = ORG()
    number = T()
    date = T(null=False)
    mode = T('quantity')
    reason = T()
    account_id = I()
    reference = T()
    description = T()
    status = T('draft')
    lines = T('[]')
    created_at = created()

    class Meta:
        db_table = 'inventory_adjustments'
        indexes = [models.Index(fields=['org', 'date'], name='ix_inv_adj_org')]


class PriceList(models.Model):
    org = ORG()
    name = T(null=False)
    description = T()
    applies_to = T('sales')
    type = T('per_item')
    percentage = R(0)
    rounding = T('none')
    items = T('[]')
    currency = T()
    is_active = I(1)
    created_at = created()

    class Meta:
        db_table = 'price_lists'
        indexes = [models.Index(fields=['org'], name='ix_price_lists_org')]


# ---------------------------------------------------------------- portal / projects / settings

class PaymentLink(models.Model):
    org = ORG()
    token = models.TextField(unique=True)
    contact_id = I()
    amount = R(null=False)
    description = T()
    expires_on = T()
    status = T('active')
    payment_id = I()
    created_by = I()
    created_at = created()

    class Meta:
        db_table = 'payment_links'
        indexes = [models.Index(fields=['org', 'status'], name='ix_payment_links_org')]


class Project(models.Model):
    org = ORG()
    name = T(null=False)
    code = T()
    customer_id = I()
    billing_method = T('project_hours')
    rate = R(0)
    budget_type = T('none')
    budget_hours = R(0)
    budget_amount = R(0)
    description = T()
    status = T('active')
    users = T()
    created_at = created()

    class Meta:
        db_table = 'projects'
        indexes = [models.Index(fields=['org', 'status'], name='ix_projects_org')]


class ProjectTask(models.Model):
    org = ORG()
    project = fk('Project')
    name = T(null=False)
    description = T()
    rate = R(0)
    billable = I(1)

    class Meta:
        db_table = 'project_tasks'
        indexes = [models.Index(fields=['project'], name='ix_tasks_project')]


class TimeEntry(models.Model):
    org = ORG()
    project = fk('Project')
    task_id = I()
    user_id = I()
    date = T(null=False)
    minutes = I(0)
    notes = T()
    billable = I(1)
    invoice_id = I()
    timer_started_at = T()
    approval_status = T('approved')
    created_at = created()

    class Meta:
        db_table = 'time_entries'
        indexes = [models.Index(fields=['org', 'project', 'date'], name='ix_time_org'),
                   models.Index(fields=['org', 'user_id', 'timer_started_at'], name='ix_time_user'),
                   models.Index(fields=['invoice_id'], name='ix_time_invoice')]


class ReminderLog(models.Model):
    org = ORG()
    document = fk('Document')
    rule_key = T(null=False)
    sent_on = T(null=False)

    class Meta:
        db_table = 'reminder_log'
        indexes = [models.Index(fields=['document', 'rule_key', 'sent_on'], name='ix_reminder_log')]
