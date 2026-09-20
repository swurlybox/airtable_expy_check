# Single Nodejs Script to check Airtable Inventory for close-to-expiry products.

## Flow
The program fetches SKUs from Airtable, cross-references with Seller Central, and flags products
that are at risk of expiration.

logs/at_risk_log contains products categorized within expiration buckets, and are at risk of expiring
at their current sales velocity rate.

logs/expy_log contains all products within inventory.

Note that the algorithm used is based on an assumption that Amazon sells products from
oldest shipment first. Therefore the output is only an estimation, and decision of whether
to liquidate the product is left to the seller's discretion.

## Setup Instructions

1. Clone the repository.
2. `npm install` in the root of the repo to install package dependencies.
3. `cp .env.example .env` to copy template environment variables.
4. Populate AIRTABLE_TOKEN with an Airtable Token to your Airtable Database. It should have read permissions.
5. Populate AIRTABLE_BASE_ID with the base id of your Airtable Database. You can find it in the URL, beginning with the token 'appXXXXXXXX'.
6. Populate the envs for the Bay Area Import Seller Party API.
6. `node index.js` to run the script.

## Dependencies

* dayjs
* dotenv