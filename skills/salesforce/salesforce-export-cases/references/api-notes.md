# Salesforce Service Cloud export API notes

Sources:
- [Bulk API 2.0 Query](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/query_bulk_api_2_0.htm)
- [Get Results for a Query Job](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/query_get_job_results.htm)
- [Bulk API limits and allocations](https://developer.salesforce.com/docs/atlas.en-us.salesforce_app_limits_cheatsheet.meta/salesforce_app_limits_cheatsheet/salesforce_app_limits_platform_bulkapi.htm)
- [PK Chunking](https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/async_api_headers_enable_pk_chunking.htm)
- [EmailMessage object](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_emailmessage.htm)
- [CaseComment object](https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_casecomment.htm)

## Where case conversation text lives

There is no single conversation object. Depending on org configuration:

| Object | Text field | Author signal | Visibility signal |
| --- | --- | --- | --- |
| `CaseComment` | `CommentBody` | `CreatedById` | `IsPublished` |
| `EmailMessage` | `TextBody`, `HtmlBody` | `Incoming`, `FromAddress` | always customer-facing |
| `FeedItem` | `Body` | `CreatedById` | internal unless exposed to a community |

All three link to the case through `ParentId`.

**Exporting only `CaseComment` is the standard mistake.** On an Email-to-Case org
the email thread is the conversation, and `CaseComment` may hold only a handful of
internal notes. The export looks fine and contains almost none of the dialogue.

`EmailMessage.HtmlBody` and `TextBody` can be empty on some records depending on
org settings and how the email arrived — check both, and prefer `TextBody` for
analysis.

## Bulk API 2.0 query flow

```
POST /services/data/v61.0/jobs/query
{
  "operation": "queryAll",
  "query": "SELECT Id, Subject FROM Case WHERE LastModifiedDate >= 2026-01-01T00:00:00.000Z",
  "contentType": "CSV",
  "lineEnding": "LF"
}
```

Then:

```
GET /services/data/v61.0/jobs/query/{jobId}
```

State values include `UploadComplete`, `InProgress`, `JobComplete`, `Aborted`,
`Failed`. Results are only available at `JobComplete`.

```
GET /services/data/v61.0/jobs/query/{jobId}/results?maxRecords=50000
Accept: text/csv
```

Response headers drive pagination:

| Header | Meaning |
| --- | --- |
| `Sforce-Locator` | Locator for the next page. The string `'null'` means done |
| `Sforce-NumberOfRecords` | Records in this response |

Pass the locator back as the `locator` query parameter. **Use only the header
value** — constructing locators by hand is explicitly unsupported.

A single bulk query can return up to 15 GB across 15 files of 1 GB. `DELETE` on the
job path removes it if you want to free a concurrency slot.

## `query` vs `queryAll`

`queryAll` includes archived and soft-deleted records; `query` does not. Use
`queryAll` for exports, or counts will undershoot the org with no indication why.
This is the same distinction as SOQL's `ALL ROWS`.

## PK chunking

The `Sforce-Enable-PKChunking` request header splits a large query by record id
ranges. Supported for standard objects including **Account, Campaign,
CampaignMember, Case, CaseHistory, Contact, Event, EventRelation, Lead,
LoginHistory, Opportunity, Task, User**, plus custom objects.

Useful when a `Case` query is large enough to time out. Note `EmailMessage`,
`CaseComment`, and `FeedItem` are **not** in the supported list, so those must be
narrowed by date window instead.

## Limits worth knowing

- **24-hour API request allocation** per org, scaling with licence count. Large or
  repeated exports can exhaust it; the symptom is a 403 with
  `REQUEST_LIMIT_EXCEEDED`.
- **Concurrent bulk job limits** apply per org — see the limits cheat sheet.
- **Access tokens are short-lived.** A long export outlives one; refresh and resume
  rather than restarting.
- **Query timeouts.** Narrow the window if a job does not complete.

## Field notes

**Case**

| Field | Note |
| --- | --- |
| `Status` | Org-configurable. Map on well-known values, keep the raw |
| `IsClosed` | The reliable closed signal, independent of picklist labels |
| `Origin` | Org-configurable channel. Substring-match, keep the raw |
| `ContactId` | The customer. May be null on cases created without a contact |
| `OwnerId` | A **User or a Group** (queue). Resolving which needs another query |
| `IsDeleted` | Only populated under `queryAll` |

There is no team field on `Case`. Queue ownership is inside `OwnerId`, so mapping
it to a canonical `team_id` would silently conflate agents with queues.

**EmailMessage**

`Incoming: true` marks a customer email. Inbound email has no Salesforce user, so
the identity is `FromAddress` — an email address, not a Salesforce Id. Any join
across message authors must handle both identifier kinds.

**Timestamps** are ISO 8601 with milliseconds and a `Z` suffix; SOQL date literals
must be unquoted (`LastModifiedDate >= 2026-01-01T00:00:00.000Z`).

## Other useful objects

| Need | Object |
| --- | --- |
| Status/field change history | `CaseHistory` |
| Milestones / entitlements (SLA) | `CaseMilestone`, `Entitlement` |
| Contacts, accounts for joins | `Contact`, `Account` |
| Agents | `User` |
| Queues | `Group`, `QueueSobject` |
| Attachments | `ContentDocumentLink`, `ContentVersion` |
| Live chat transcripts | `LiveChatTranscript` |
| Messaging sessions | `MessagingSession`, `MessagingEndUser` |

Orgs using Service Cloud Voice, Messaging, or Chat hold those conversations in
their own objects — `Case` alone will not cover them.
