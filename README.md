# Single Nodejs Script to check Airtable Inventory for close-to-expiry products.

## Flow
The program fetches the items from the most recent shipment (right-most table within the Airtable Base), and sorts the products into buckets of:

* expired
* expires in 30 days
* expires in 60 days
* expires in 90 days

Output is logged on the console and in logs/expy_log file.

This is just a quick hack-up of an example implementation. If you want to integrate it into a web-app dashboard, you should make modifications as needed or create your own script.

## Setup Instructions

1. Clone the repository.
2. `npm install` in the root of the repo to install package dependencies.
3. `cp .env.example .env` to copy template environment variables.
4. Populate AIRTABLE_TOKEN with an Airtable Token to your Airtable Database. It should have read permissions.
5. Populate AIRTABLE_BASE_ID with the base id of your Airtable Database. You can find it in the URL, beginning with the token 'appXXXXXXXX'.
6. `node index.js` to run the script.

## Dependencies

* dayjs
* dotenv