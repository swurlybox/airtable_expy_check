/* Write a simple script that fetches SKU data from airtable, sorts them out
    into expiration categories (30/60/90 days), and logs them into a file
    every week. */
require('dotenv').config();
const dayjs = require('dayjs');
dayjs().format();
const fs = require('node:fs');

/* Default behavior: look at the most recent shipment. */
async function main() {
    const BASE_ID = process.env.AIRTABLE_BASE_ID;
    const TOKEN = process.env.AIRTABLE_TOKEN;

    /* Start off by fetching the most recent shipment to get the tableID. */
    let url = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`;
    let response = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${TOKEN}`
        }
    });

    /* Could have an option where user is allowed to select the particular shipment,
        to run the expy check on. If this were integrated into a dashboard web-app,
        we'd need the frontend to be able to choose the shipment. Due to API
        rate limits, we should only list records from one shipment every 1-2 seconds. */
    let data = await response.json();

    let TABLE_ID = data.tables.at(-1).id;

    /* Fetch all the records from this particular shipment. (Is there a way to sort by expy date on
        the Airtable API side?). Shipment records usually don't exceed 100 entries per table, so the
        default page-size of 100 records fetched is fine for now. */
    url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`
    response = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${TOKEN}`
        }
    })

    data = await response.json();

    /* Sort the SKUs into their own buckets (30, 60, 90 days within expiration). */
    const alias_map = {
        expiration_date : ['expiration date', 'expy date'],
    };

    /* Find the field name for the expiration date. */
    let field_name;
    let found = false;
    for (field_name in data.records[0].fields) {
        for (const alias of alias_map.expiration_date) {
            if (field_name.toLowerCase().includes(alias)) {
                found = true;
                break;
            }
        }
        if (found) {
            break;
        }
    }

    if (!found) {
        console.log("Couldn't find expiration field.");
        return;
    }

    const buckets = {
        expired: [],
        expires_30: [],
        expires_60: [],
        expires_90: []
    };

    const today = dayjs();

    data.records.forEach(record => {
        const exp_date = dayjs(record.fields[field_name]);
        const diff_days = exp_date.diff(today, 'days');

        if (diff_days < 0) {
            buckets.expired.push(record.fields);
        } else if (diff_days < 30) {
            buckets.expires_30.push(record.fields);
        } else if (diff_days < 60) {
            buckets.expires_60.push(record.fields);
        } else if (diff_days < 90) {
            buckets.expires_90.push(record.fields);
        }
    });

    console.dir(buckets);

    /* Format output to a log file. */
    let logMessage = `[${new Date().toISOString()}] INFO: Application started\n`;
    for (const category in buckets) {
        switch (category) {
            case "expired":
                logMessage += "Expired:\n"
                break;
            case "expires_30":
                logMessage += "Expires within 30 days:\n"
                break;
            case "expires_60":
                logMessage += "Expires within 60 days:\n"
                break;
            case "expires_90":
                logMessage += "Expires within 90 days:\n"
                break;
        }

        for (const item of buckets[category]) {
            logMessage += '\t' + JSON.stringify(item) + '\n';
        }
        logMessage += '\n';
    }

    logMessage += "========================================================\n";

    console.log(logMessage);

    fs.mkdirSync("logs", {recursive: true});
    fs.appendFileSync('logs/expy_log', logMessage, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });
}

main();