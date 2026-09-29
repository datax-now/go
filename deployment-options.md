# Deployment recommendation

Date: 2026-09-25. Prices in USD; taxes excluded. Official sources were retrieved for this report. **Documented** denotes provider documentation; **local** denotes repository evidence; **assessment** denotes inference or recommendation, not a service guarantee.

## Recommendation

**Assessment:** Keep the existing private **R2 Standard + streaming Worker** as the main delivery architecture, preferably on an IT-approved hostname. In parallel, ask **Read the Docs (RTD) support** to approve this workload and investigate its challenges. Preserve RTD as a documentation entry point and, if support agrees and corporate testing succeeds, a complete application mirror. Do not replace the required 500 MB-per-visit download with a caching assumption.

Corporate access is a separate acceptance criterion from hosting capacity and price. The reported advantage of `readthedocs.io` is user-provided evidence about target networks, not a universal allowlist. A link, redirect, iframe, or cross-origin asset request from an allowed RTD page does **not** transfer that permission to R2, `workers.dev`, `cloudfront.net`, Vercel, or a new custom domain. If only RTD is permitted and it cannot support delivery, an IT-approved hostname or company-hosted mirror is necessary; changing cloud providers alone does not solve this.

**Local:** [README.md](README.md) records RTD challenge/429 responses, protected Vercel staged URLs, and the existing private R2 deployment. [cloudflare/worker.mjs](cloudflare/worker.mjs) streams `object.body`, sets `COOP: same-origin` and `COEP: require-corp`, handles ranges and validators, and reads R2 through a binding. It contains no explicit edge Cache API integration. Its `s-maxage=300` header alone is not evidence of R2 edge-cache hits. Dashboard caching settings and current production behavior were not audited. The README's browser-cache optimization is not credited in the calculations below.

## Cloudflare: verified economics and limits

| Documented item | Current published terms |
| --- | --- |
| R2 Standard storage | $0.015/GB-month; 10 GB-month/month free. Storage uses the average daily peak. [1] |
| R2 Class A | $4.50/million; 1 million/month free. Includes writes, lists and multipart upload operations. [1] |
| R2 Class B | $0.36/million; 10 million/month free. Includes GET and HEAD. [1] |
| R2 retrieval/egress | No Standard retrieval fee; internet egress is free, explicitly including access through the Workers API. Other connected services can still charge. [1] |
| R2 rounding | Usage rounds up to whole billing units: million-operation units and GB-month units. Do not assume fractional-million R2 billing. [1] |
| Workers Paid Standard | $5/month account minimum; 10 million requests and 30 million CPU-ms included; excess $0.30/million requests and $0.02/million CPU-ms. No bandwidth/egress or duration charge. [2] |
| Worker response and memory | No enforced response-body size limit; 128 MB memory per isolate. Stream large bodies, do not buffer them. Network waiting is not CPU time. HTTP duration has no hard limit while connected, but disconnects/runtime updates can interrupt delivery. [3] |
| Edge cache object maximum | CDN: 512 MB on Free/Pro/Business; 5 GB default on Enterprise. Workers Cache API table separately lists 512 MB on both Free and Paid. A $5 Workers subscription is not an Enterprise CDN upgrade. [3][4] |
| Static asset upload maximum | Pages and Workers Static Assets: **25 MiB per file**. These are different products/limits from streaming R2 through Worker code. [3][5] |

**Assessment:** Assets over 25 MiB rule out an all-in-one Pages/Workers Static Assets deployment, not the existing R2 architecture. A file over the applicable cache maximum can still be streamed by the Worker; do not budget an edge hit for it. Limits are per object, not the sum downloaded during a visit. Provider documentation labels cache limits in MB/GB; do not silently equate them with MiB/GiB. Use Standard rather than Infrequent Access for repeated downloads: the latter has retrieval charges and no Standard free tier. [1]

### Traffic and request model

**Assumptions:** Every visit transfers exactly **500,000,000 bytes** to the browser, regardless of previous visits. Visits are monthly. This is the lower-bound model for a 500 MB+ requirement, excluding retries, protocol overhead, extra notebooks and optional archives. Decimal MB/GB/TB are used below; storage size is independent of cumulative traffic.

| Visits/month | Download bytes/month | Decimal traffic | Worker requests at 100/visit | Worker requests at 1,000/visit |
| --- | --- | --- | --- | --- |
| 1,000 | 500,000,000,000 | 500 GB / 0.5 TB | 100,000 | 1,000,000 |
| 10,000 | 5,000,000,000,000 | 5,000 GB / 5 TB | 1,000,000 | 10,000,000 |
| 100,000 | 50,000,000,000,000 | 50,000 GB / 50 TB | 10,000,000 | 100,000,000 |

R2 and Workers **egress charges are $0 in all three cases**, not the entire hosting bill. Edge caching can reduce origin reads without reducing the mandatory browser download.

Illustrative monthly **Worker + R2 Class B** subtotals, assuming one R2 GET per request, no edge hits, **5 CPU-ms/request**, and otherwise unused account allowances:

| Visits/month | 100 requests/visit | 1,000 requests/visit |
| --- | --- | --- |
| 1,000 | $5.00 | $5.00 |
| 10,000 | $5.00 | $5.40 |
| 100,000 | $5.40 | $73.80 |

For monthly Worker requests `N`, total CPU-ms `C`, and R2 reads `B`, the subtotal is `5 + 0.30*max(N-10e6,0)/1e6 + 0.02*max(C-30e6,0)/1e6 + 0.36*ceil(max(B-10e6,0)/1e6)`. At 100 million requests: $5 base + $27 Worker requests + $9.40 CPU + $32.40 R2 reads = **$73.80**. These request counts and CPU costs are scenarios, not measurements.

Add storage, Class A deployment operations, domain registration, optional logging/support, and other account usage. For example, 20 GB-month of Standard storage adds $0.15 with an otherwise unused 10 GB allowance. Allowances are not separately available for every project. The actual Worker can issue **HEAD then GET** on a stale conditional GET: two Class B operations for one Worker request. HEAD/304 requests, range requests, retries and background fetches affect counts. R2-backed requests execute Worker code; do not apply the separate free Workers Static Assets request offer. Measure requests/visit, R2 operations and CPU before treating the subtotal as a budget. [1][2]

## Read the Docs: retain the access advantage, seek approval

**Documented:** Both Community and Business use Cloudflare CDN. Buying Business does not inherently remove Cloudflare. RTD's automated-access guidance asks for under **4 requests/second**, or **1 request/second for documentation downloads**; small bursts are tolerated. It also uses analysis beyond simple IP rate limits, supports caching, and considers increased limits or incorrect blocks case by case. These are automated-access guidelines, **not a published browser-runtime throughput SLA**, byte quota, or the API's separate rate limit. [6][7]

**Assessment:** A large browser runtime with many parallel fetches, particularly behind shared corporate egress, needs explicit suitability confirmation. The reviewed pages do not guarantee unrestricted 500 MB-per-visit application distribution; they also do not establish that this app is categorically forbidden. Ask support whether this workload is supported, including largest objects, total build size, 0.5/5/50 TB monthly scenarios, request bursts and required isolation headers. Request a review of legitimate runtime requests, not challenge evasion. A service worker or CORS change cannot guarantee resolution of a provider challenge.

Use the Community form at <https://app.readthedocs.org/support/> or Business form at <https://app.readthedocs.com/support/>. If account access is unavailable, the documented fallbacks are `support@readthedocs.org` and `support@readthedocs.com`, respectively. Include affected URLs, UTC timestamps, status, `cf-ray`, `cf-mitigated`, browser user agent and requesting IP/network details through the private support channel; omit cookies and tokens. Community replies are best-effort; Business documents a two-business-day response for most plans, with faster options. [7][8]

## AWS alternative: private S3 + CloudFront

**Documented:** CloudFront supports a private regular S3 bucket origin using Origin Access Control (OAC); an S3 website endpoint cannot use OAC. Custom response-header policies can add COOP/COEP. The developer quota reference lists **50 GB per cacheable GET response**, comfortably above 25 MiB. The FAQ still says 30 GB maximum delivery: this official-source inconsistency should be confirmed for very large archives, though neither limit obstructs a 500 MB object. AWS-origin transfer to CloudFront is free; that does not make viewer delivery or S3 operations universally free. [9][10][11][12]

**Assessment:** This is a credible independently operated alternative if corporate IT approves it. Keep the whole app on one HTTPS origin, add the exact isolation headers through a custom response policy, preserve MIME/range/validator behavior, and reproduce directory-index mappings such as `/lab/` to `/lab/index.html`. Do not stream binaries through Lambda@Edge-generated responses. Migration and IT approval are additional work, so there is no demonstrated need to replace the existing R2 deployment solely for file size.

**Documented pricing choices:** Pay-as-you-go includes **1 TB viewer transfer and 10 million HTTP/HTTPS requests monthly**, shared across the account (one allowance per organization under consolidated billing); excess transfer and requests are region/tier-priced. S3 storage and origin operations are additional. Edge hits reduce S3 reads, not billable viewer bytes. The current regional rate tables on the AWS pricing pages could not be extracted in this session, so no unverified pay-as-you-go dollar totals are quoted. [12]

AWS also publishes flat-rate plans: **Pro $15/month, 50 TB and 10 million requests; Business $200/month, 50 TB and 125 million requests**. Business includes custom response-header policies; Free/Pro do not. Pro includes CloudFront Functions, so function-added isolation headers are a possible alternative requiring separate validation, not assumed equivalent here. For the straightforward custom-policy design, Business is the relevant published $200/month baseline at each traffic level above, **plus uncovered S3 operations and other extras**. At 100,000 visits the 50 TB decimal payload is already at the nominal allowance, before overhead; plan headroom against AWS's metering. At 1,000 requests/visit, 100 million monthly requests exceed Pro's allowance but fit Business's. Storage credits are not a blanket waiver of S3 request charges. [12][13]

Flat-rate plans have no overage charges, but sustained substantial excess or unusually high usage can lead to delivery/performance adjustments. Check eligibility and included features; do not describe them as unconditional unlimited delivery. The Free flat-rate plan's 100 GB/1 million allowance is distinct from the pay-as-you-go free tier. [13]

## Decision gates and caveats

1. Seek RTD workload approval/block review while keeping the current R2 deployment available. Use an IT-approved exact hostname or company-managed mirror when required; obtain approval for every essential external dependency too. Do not assume redirects or switching CDNs bypass corporate policy.
2. Before choosing a public URL, test anonymously from representative corporate networks: HTML, manifest, service worker, largest binary, kernel startup, COOP/COEP and `crossOriginIsolated`. Measure full-session transferred bytes, request counts and CPU, including shared-egress concurrency. No such corporate acceptance test was performed for this report.
3. Keep Vercel staged URLs for authorized review, not public distribution. Vercel documents login redirects on protected deployments; the local SSO symptom is consistent with access protection, not proof of a static-hosting defect. Verify production URL protection separately; do not broadly disable protection or expose bypass secrets. [14]
4. Hosting, PWA installation and cached runtime files do **not** guarantee whole-app offline operation. Storage eviction, uncached packages/data, external services and origin-specific browser storage remain relevant. No offline guarantee or reduction of the required per-visit payload is assumed.

## Official sources

[1] [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).
[2] [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
[3] [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).
[4] [Cloudflare CDN cache behavior and size limits](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).
[5] [Pages limits](https://developers.cloudflare.com/pages/platform/limits/).
[6] [RTD CDN and caching](https://docs.readthedocs.com/platform/stable/reference/cdn.html).
[7] [RTD automated access and block review](https://docs.readthedocs.com/platform/stable/automated-access.html).
[8] [RTD support routes](https://docs.readthedocs.com/platform/stable/support.html).
[9] [CloudFront OAC for S3](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).
[10] [CloudFront response-header policies](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html).
[11] [CloudFront quotas](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html).
[12] [CloudFront FAQ: prices, free tier, origin transfer and billing](https://aws.amazon.com/cloudfront/faqs/).
[13] [CloudFront flat-rate plan allowances, features and caveats](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).
[14] [Vercel Authentication](https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication).

Research note: No applicable ancestor/root AGENTS.md, CLAUDE.md or repository Copilot instruction files were found. Context7 could not be loaded because the required deferred-tool search loader was unavailable; official pages were fetched directly instead. AWS CloudFront/S3 marketing pricing tables failed extraction; AWS pricing claims above rely on the retrieved official FAQ and developer guide. No agents were delegated and no application/configuration changes were made.

[1]: https://developers.cloudflare.com/r2/pricing/
[2]: https://developers.cloudflare.com/workers/platform/pricing/
[3]: https://developers.cloudflare.com/workers/platform/limits/
[4]: https://developers.cloudflare.com/cache/concepts/default-cache-behavior/
[5]: https://developers.cloudflare.com/pages/platform/limits/
[6]: https://docs.readthedocs.com/platform/stable/reference/cdn.html
[7]: https://docs.readthedocs.com/platform/stable/automated-access.html
[8]: https://docs.readthedocs.com/platform/stable/support.html
[9]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html
[10]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/understanding-response-headers-policies.html
[11]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-limits.html
[12]: https://aws.amazon.com/cloudfront/faqs/
[13]: https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html
[14]: https://vercel.com/docs/deployment-protection/methods-to-protect-deployments/vercel-authentication
