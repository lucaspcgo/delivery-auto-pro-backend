# Prompt: Admin Planos/Usuários & Plan Gating (Lovable)

## Overview

Build two admin tabs and integrate plan gating throughout the user-facing app. Admin manages subscription plans and user accounts; the frontend enforces capability locks and quota limits based on user's active plan.

---

## Part 1: Admin "Planos" Tab

**Purpose:** Create, edit, and manage subscription plans (pricing tiers).

### Table Display
Show all plans (active + inactive) from `GET /api/v1/plans/all` with columns:
- **Name** (text)
- **Slug** (identifier, e.g., `starter`, `pro`, `enterprise`)
- **Price** (formatted currency, e.g., $29.99)
- **Billing Period** (weekly / monthly / yearly)
- **Popular** (badge or star icon if `popular: true`)
- **Free** (badge if `is_free: true`)
- **Status** (active / inactive toggle)
- **Max Restaurants** (count, or "Unlimited" if 0)
- **Max Orders/Month** (count, or "Unlimited" if 0)
- **Actions** (Edit, Delete buttons)

### Edit/Create Form
Modal or side panel with these fields:

#### Basic Info
- **Name** (text input, required)
- **Slug** (text input, unique, alphanumeric + hyphen, required)
- **Price** (number input, $ format, required)
- **Billing Period** (dropdown: `weekly`, `monthly`, `yearly`, required)

#### Plan Flags
- **Active** (toggle)
- **Popular** (toggle — highlight this plan in customer list)
- **Free Plan** (toggle — zero price)

#### Features & Capabilities
- **Features** (textarea or editable list of text strings; each line is one feature)
  - Examples: "Automated order acceptance", "Menu synchronization", "Mobile app access"
- **Menu Sync** (capability toggle)
- **Auto Accept** (capability toggle)

#### Limits (0 = Unlimited)
- **Max Restaurants** (number input, non-negative)
- **Max Orders per Month** (number input, non-negative)

#### Sort Order
- **Sort Order** (number input, for ordering plans in public list)

### API Interactions
- **List:** `GET /api/v1/plans/all` (requires admin Bearer JWT)
- **Create:** `POST /api/v1/plans` with all fields above
- **Update:** `PUT /api/v1/plans/:id` with fields to modify
- **Delete:** `DELETE /api/v1/plans/:id` (deactivates the plan)

### Validation & UX
- Slug must be unique across all plans
- Price must be ≥ 0
- Billing period is required
- On successful create/update, refresh the table
- Delete/deactivate shows confirmation dialog
- Show error toast on API failure

---

## Part 2: Admin "Usuários" Tab

**Purpose:** View users and manage their subscription and account status.

### User List
Display all users from `GET /api/v1/admin/users` with columns:
- **Name** (text)
- **Email** (text)
- **Plan** (current plan slug/name)
- **Payment Status** (e.g., "active", "pending", "failed")
- **Active** (status/toggle or badge)
- **Created At** (date)
- **Actions** (Edit, View Details buttons)

### User Edit Modal
When opening a user's edit screen:

#### Account Info (display only)
- User ID
- Name
- Email
- Created At

#### Plan & Status Management
- **Assigned Plan** (dropdown, shows all active plans from `GET /api/v1/plans`, required)
- **Account Active** (toggle)

#### Optional: Payment Info
- **Payment Status** (display or editable, e.g., "active", "overdue")

### API Interactions
- **List:** `GET /api/v1/admin/users` (requires admin Bearer JWT)
- **Update:** `PUT /api/v1/admin/users/:id` with `{ plan, active, ... }`
  - The API validates the plan slug against active plans
- On successful update, refresh the table

### Validation & UX
- Plan field must reference an active plan
- Deactivating a user should show confirmation ("User will lose access")
- Show error toast if plan is invalid or inactive
- Display which users are currently over limits (optional UX enhancement)

---

## Part 3: User-Facing Plan Gating

**Purpose:** Enforce plan features and limits in the app for logged-in users.

### Usage Endpoint & State
On login or when entering a section, call `GET /api/v1/usage` (no params, uses session/JWT):

```json
{
  "plan": "pro",
  "capabilities": {
    "menu_sync": true,
    "auto_accept": true
  },
  "restaurants_count": 3,
  "max_restaurants": 5,
  "orders_this_month": 142,
  "max_orders_month": 500,
  "over_limit": false
}
```

Store this in app state/context; refresh on screen/tab focus if needed.

### Button/Feature Locks (Capabilities)

**Menu Sync Button/Toggle:**
- If `capabilities.menu_sync === false`, disable the button and show tooltip: "Menu synchronization available on [Plan Name] plan" with link to upgrade
- If enabled, show as normal

**Auto Accept Button/Toggle:**
- If `capabilities.auto_accept === false`, disable the button and show tooltip: "Auto-accept available on [Plan Name] plan" with link to upgrade
- If enabled, show as normal

### Usage Counters

In relevant screens (Restaurants, Orders), display:
- **Restaurants Used:** `{restaurants_count} / {max_restaurants}` (or "{restaurants_count} / Unlimited")
  - If `restaurants_count === max_restaurants` and `max_restaurants > 0`, show warning badge: "Limit reached"
- **Orders This Month:** `{orders_this_month} / {max_orders_month}` (or "{orders_this_month} / Unlimited")
  - If `orders_this_month >= max_orders_month` and `max_orders_month > 0`, show warning badge: "Limit reached"

### Over-Limit Warnings

If `over_limit === true` in usage:
- Show prominent warning banner at top of relevant screens: "You've reached your plan limit. Upgrade to [next_tier] to increase capacity."
- Button: "View Plans" → navigate to plans/upgrade page (if exists)
- Do NOT block functionality, only warn; backend enforces hard limits

### Error Handling: Plan Gating Responses

When any API call returns `403` with one of these error objects, show user-friendly modals:

#### `{ error: 'plan_upgrade_required', capability: 'menu_sync' | 'auto_accept' }`
**Modal:**
```
Title: "Feature Not Available"
Body: "[menu_sync/auto_accept] is only available on [Current Plan or higher] plans."
Buttons: ["Upgrade Plan" → navigate to pricing], ["Dismiss"]
```

#### `{ error: 'plan_limit_reached', limit: 'restaurants' | 'orders_monthly', max: 5 | 500, current: 5 | 501 }`
**Modal:**
```
Title: "Plan Limit Reached"
Body: "You've reached the limit of {max} [restaurants/orders per month]. Upgrade to increase capacity."
Buttons: ["Upgrade Plan" → navigate to pricing], ["Dismiss"]
```

#### `{ error: 'account_inactive' }`
**Modal:**
```
Title: "Account Inactive"
Body: "Your account is currently inactive. Please contact support."
Buttons: ["Contact Support" → open support form/email], ["Dismiss"]
```

#### `{ error: 'trial_expired' }`
**Modal:**
```
Title: "Trial Expired"
Body: "Your free trial has ended. Upgrade to a paid plan to continue."
Buttons: ["View Plans" → navigate to pricing], ["Dismiss"]
```

### Pricing / Upgrade Page (Optional)

If not already built:
- Display all active plans from `GET /api/v1/plans` (public endpoint)
- Show plan cards with name, price, billing period, popular badge, feature list, max limits
- Sort by `sort_order`
- Button on each card: "Choose Plan" → checkout flow

---

## Technical Notes

### Headers & Auth
- All admin endpoints require Bearer token: `Authorization: Bearer <JWT_token>`
- JWT must have `is_admin: true` claim
- User endpoints require valid user session/JWT
- Public `GET /api/v1/plans` needs no auth

### Error Responses
- Expect standard HTTP status codes: 200 (success), 400 (validation), 403 (gating), 404 (not found), 500 (server error)
- Response body: `{ error: string, details?: string | object }`
- For gating errors: `{ error: string, capability?: string, limit?: string, max?: number, current?: number }`

### Data Types
- **Slug:** lowercase alphanumeric + hyphens (e.g., `starter-pro`)
- **Price:** decimal (e.g., 29.99)
- **Billing Period:** enum `'weekly' | 'monthly' | 'yearly'`
- **Capabilities:** `{ menu_sync: boolean, auto_accept: boolean }`
- **Limits:** non-negative integers; 0 means unlimited
- **Timestamps:** ISO 8601 format (e.g., `2026-01-15T10:30:00Z`)

### Performance Tips
- Cache usage data in app state; refresh on user action or tab focus
- Lazy-load user list with pagination if user count is large
- Debounce edits to prevent duplicate requests

---

## Acceptance Criteria

✅ Admin "Planos" tab: Full CRUD for plans with all fields, toggles, and list editing  
✅ Admin "Usuários" tab: List users, assign plans, toggle active status  
✅ User-facing locks: Disable menu_sync/auto_accept buttons if capability false  
✅ Usage display: Show counters and warnings when over_limit  
✅ Error handling: All four 403 errors show appropriate modals with CTAs  
✅ API consumption: All endpoints used with correct headers, payloads, and auth  
✅ UX polish: Toasts, confirmations, validation messages, and loading states  
