/* Write a simple script that fetches SKU data from airtable, sorts them out
    into expiration categories (30/60/90 days), and logs them into a file
    every week. */
require('dotenv').config();
const dayjs = require('dayjs');
dayjs().format();
const fs = require('node:fs');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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
    //console.log(data);

    /* Sort the SKUs into their own buckets (30, 60, 90 days within expiration). */
    const alias_map = {
        expiration_date : ['expiration date', 'expy date'],
        sku : ['sku'],
        name : ['name.'],
    };
    /* This script could run on older shipments. */
    const buckets = {
        expired: [],
        expires_30: [],
        expires_60: [],
        expires_90: []
    };

    const today = dayjs();

    let expy_field_name;
    let sku_field_name;
    let name_field;
    let found;
    let TABLE_ID;
    /* Want to iterate through all the tables. */
    for (const table of data.tables) {
        TABLE_ID = table.id;

        /* Fetch all the records from this particular shipment. (Is there a way to sort by expy date on
        the Airtable API side?). Shipment records usually don't exceed 100 entries per table, so the
        default page-size of 100 records fetched is fine for now. */
        await delay(500);
        url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`
        response = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${TOKEN}`
            }
        });

        data = await response.json();
        // console.dir(data, {depth: null, color: true});

        /* Find the field name for the expiration date */
        found = false;
        for (expy_field_name in data.records[0].fields) {
            for (const alias of alias_map.expiration_date) {
                if (expy_field_name.toLowerCase().includes(alias)) {
                    found = true;
                    break;
                }
            }
            if (found) {
                break;
            }
        }

        if (!found) {
            console.log(`Couldn't find expiration field for ${table.name}.`);
            continue;
        }

        /* Find the field name for the SKUs. Should be an exact match to avoid
            FNSKU. */
        found = false;
        for (sku_field_name in data.records[0].fields) {
            for (const alias of alias_map.sku) {
                if (sku_field_name.toLowerCase() == (alias)) {
                    found = true;
                    break;
                }
            }
            if (found) {
                break;
            }
        }

        if (!found) {
            console.log(`Couldn't find sku field for ${table.name}.`);
            continue;
        }

        /* Find the field name for the Name. */
        found = false;
        for (name_field in data.records[0].fields) {
            for (const alias of alias_map.name) {
                if (name_field.toLowerCase().includes(alias)) {
                    found = true;
                    break;
                }
            }
            if (found) {
                break;
            }
        }

        if (!found) {
            console.log(`Couldn't find name field for ${table.name}.`);
            continue;
        }

        data.records.forEach(record => {
            const exp_date = dayjs(record.fields[expy_field_name]);
            const diff_days = exp_date.diff(today, 'days');

            const obj = {
                SKU: record.fields[sku_field_name],
                EXP: record.fields[expy_field_name],
                SHIPMENT: table.name,
                NAME: record.fields[name_field],
            };

            /* Ignore empty records and no expiration date records. */
            if (!(obj.SKU && obj.EXP && obj.NAME)) {
                return;
            }

            if (diff_days < 0) {
                buckets.expired.push(obj);
            } else if (diff_days < 30) {
                buckets.expires_30.push(obj);
            } else if (diff_days < 60) {
                buckets.expires_60.push(obj);
            } else if (diff_days < 90) {
                buckets.expires_90.push(obj);
            }
        });

    }

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