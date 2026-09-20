/* Write a simple script that fetches SKU data from airtable, sorts them out
    into expiration categories (30/60/90 days), and logs them into a file
    every week. */
require('dotenv').config();
const dayjs = require('dayjs');
//dayjs().format();
const fs = require('node:fs');

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Pass in the fields schema for a shipment, and the aliases we want to match against. 
    Fields schema should take the form of data.records[0].fields, and aliases should
    be an array of strings. Exact_match is a boolean flag determining whether algorithm
    uses includes() or an exact match. Returns field name as a string if found, empty
    string if none found. */
function findFieldName(fields, aliases, exact_match) {
    let field;
    for (field of fields) {
        for (const alias of aliases) {
            if (!exact_match && field.name.toLowerCase().includes(alias)) 
                return field.name;

            if (exact_match && field.name.toLowerCase() == alias) 
                return field.name;            
        }
    }
    return "";
}

/** Fetch records from a given table. Should delay around 500ms to get around Airtable 
 *  API rate limit of 5 calls per sec.
 */
async function fetchRecords(BASE_ID, TOKEN, TABLE_ID) {
        const url = `https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`
        const response = await fetch(url, {
            headers: {
                "Authorization": `Bearer ${TOKEN}`
            }
        });
        const data = await response.json();
        return data;
}

/** Fetch tables schema. Array of tables are stored in a .tables property. */
async function fetchTables(BASE_ID, TOKEN) {
    const url = `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`;
    const response = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${TOKEN}`
        }
    });
    const data = await response.json();
    return data;
}

async function main() {
    const BASE_ID = process.env.AIRTABLE_BASE_ID;
    const TOKEN = process.env.AIRTABLE_TOKEN;

    /* Fetch the table schema. */
    let data = await fetchTables(BASE_ID, TOKEN);

    /* Alias mapping to figure out which fields to extract from each table. */
    const alias_map = {
        expiration_date : ['expiration date', 'expy date'],
        sku : ['sku'],
        name : ['name.'],
        label_qty : ['labels']
    };

    let expy_field_name;
    let sku_field_name;
    let name_field;
    let unit_qty_field;
    let order = 1;  // needed to figure out which shipments are "older".

    const sku_groups = {};

    /* 1) Fetch and sort all the records into their own SKU groups. */
    console.log("Fetching and sorting all records into their own SKU groups...");
    for (const table of data.tables) {

        /* Fetch all the records from this particular shipment. Delay by 500ms to
            get around Airtable rate limit. */
        let fields = table.fields;

        /* Skip any tables that don't match our schema. */
        expy_field_name = findFieldName(fields, alias_map.expiration_date, false);
        if (!expy_field_name) {
            console.log(`Couldn't find Expiration Date field for ${table.name}.`);
            continue;
        }

        sku_field_name = findFieldName(fields, alias_map.sku, true);
        if (!sku_field_name) {
            console.log(`Couldn't find SKU field for ${table.name}.`);
            continue;
        }

        name_field = findFieldName(fields, alias_map.name, false);
        if (!name_field) {
            console.log(`Couldn't find Product Name field for ${table.name}.`);
            continue;
        }

        unit_qty_field = findFieldName(fields, alias_map.label_qty, false)
        if (!unit_qty_field) {
            console.log(`Couldn't find Label Quantity field for ${table.name}.`);
            continue;
        }

        /* Table matches our schema, now we can proceed to fetching records. */
        await delay(500);
        data = await fetchRecords(BASE_ID, TOKEN, table.id);

        /* Start pushing records into a "map". */
        data.records.forEach(record => {

            let sku = record.fields[sku_field_name];
            let exp = record.fields[expy_field_name];
            let qty = record.fields[unit_qty_field];
            let name = record.fields[name_field];

            /* Skip any records that may have undefined fields for:
                SKU, expiration date, product name, or quantity. */
            if (!sku || !exp || !qty || !name) {
                return;
            }

            /* Get rid of \n, " double quotes */
            sku = sku.trim().replaceAll('"','');
            exp = exp.trim();

            /* Choose to skip unparseable expiration fields for now. */
            if (!dayjs(exp).isValid()) {
                return;
            }

            if (sku == undefined) {
                console.log(record); // encountered a record whose sku_field is undefined?
                console.log(table.name);
                process.exit(1);
            }

            const obj = {
                SKU: sku,
                EXP: exp,
                EST_QUANTITY: qty,
                SHIPMENT: table.name,
                NAME: name,
                ORDER: order,
            }

            /* Initialize an array if it doesn't exist yet. */
            sku_groups[`${sku}`] ||= [];
            sku_groups[`${sku}`].push(obj);
        });

        order++;
    }
    
    // console.dir(sku_groups, {depth: null, colors: true});

    /* 2) Iterate through each SKU group and lookup their on-hand quantity. Cull the
        older shipments using a FIFO lot allocation algorithm. Based on the assumption
        Amazon ships out products from the oldest shipment first. While we walk, append
        the estimated quantity (separate from label qty field). Can also delete the label
        qty field after we get the estimated quantity, or just repurpose it as the unit
        quantity. */
    console.log("Grabbing SKU on-hand quantities and culling older shipments...");
    const token = await getAccessToken(
        process.env.COMP_API_USER,
        process.env.COMP_API_PASS);

    const sku_onhand_list = await getSkusOnhand(sku_groups, token);

    for (const [sku, arr] of Object.entries(sku_groups)) {
        /* 0 on-hand quantity anyways, no expiration risk to consider. */
        if (sku_onhand_list[sku] == 0) {
            delete sku_groups[sku];
            continue;
        }
        
        for (let i = arr.length - 1; i >= 0; i--) {
            let min = Math.min(arr[i]["EST_QUANTITY"], sku_onhand_list[sku]);
            sku_onhand_list[sku] -= min;
            arr[i]["EST_QUANTITY"] = min;

            if (sku_onhand_list[sku] == 0) {
                arr.splice(0, i);
                break;
            } 
        }
    }

    /* 3) Get the sales velocity for each SKU. After that, go through each sku group,
        walk oldest to newest, and compare days-of-supply with days-till-expiry. Append
        that ratio as an expiration risk factor, and highlight the ones with a risk factor
        > 1. */
    console.log("Computing sales velocity and expiration risk ratio...");
    const sku_sales_velocity_list = await getSalesVelocity(Object.keys(sku_groups), token);

    const today = dayjs();
    for (const [sku, arr] of Object.entries(sku_groups)) {
        let cum_qty = 0;
        arr.forEach(lot => {
            cum_qty += lot["EST_QUANTITY"];

            const days_of_supply = (sku_sales_velocity_list[`${sku}`] > 0) ?
                cum_qty / sku_sales_velocity_list[`${sku}`] : Infinity; // if sales velocity is 0, it'll never sell.
            const days_till_expiry = dayjs(lot["EXP"]).diff(today, "days");
            const expiration_risk_ratio = days_of_supply / days_till_expiry;

            lot.SALES_VELOCITY = sku_sales_velocity_list[`${sku}`];
            lot.DAYS_OF_SUPPLY = days_of_supply;
            lot.DAYS_TILL_EXPIRY = days_till_expiry;
            lot.EXPIRATION_RISK_RATIO = expiration_risk_ratio;
        });
    }

    /* 4) Output step. We'll log only the entries with a pretty high expiration
        risk factor. Also might want to put them into expiration bucket categories. 
        < 3 months, < 6 months, < 9 months, < 12 months the rest. */
    const buckets = {
        "within 0-3 months": [],
        "within 3-6 months": [],
        "within 6-9 months": [],
        "within 9-12 months": [],
        "over a year": []
    }

    for (const [sku, arr] of Object.entries(sku_groups)) {
        arr.forEach(lot => {
            if (lot["EXPIRATION_RISK_RATIO"] > 1) {
                const days = lot["DAYS_TILL_EXPIRY"];
                if (days < 90) {
                    buckets["within 0-3 months"].push(lot);
                }
                else if (days < 180) {
                    buckets["within 3-6 months"].push(lot);
                }
                else if (days < 270) {
                    buckets["within 6-9 months"].push(lot);
                }
                else if (days < 360) {
                    buckets["within 9-12 months"].push(lot);
                }
                else {
                    buckets["over a year"].push(lot);
                }
            }
        })
    }

    /* Format output to a log file. */
    let logMessage = `[${new Date().toISOString()}] INFO: Application started\n`;
    logMessage += JSON.stringify(sku_groups, null, 2);
    logMessage += "========================================================\n";
    fs.mkdirSync("logs", {recursive: true});
    fs.writeFileSync('logs/expy_log', logMessage, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });

    function replacer(key, value) {
        if (value === Infinity) return "Infinity";
        if (value === -Infinity) return "-Infinity";
        if (Number.isNaN(value)) return "NaN";
        return value;
    }

    /* Log the ones that are at risk in expiration buckets in a separate file. */
    logMessage = `[${new Date().toISOString()}] INFO: Application started\n`;
    logMessage += JSON.stringify(buckets, replacer, 2);
    logMessage += "========================================================\n";
    fs.mkdirSync("logs", {recursive: true});
    fs.writeFileSync('logs/at_risk_log', logMessage, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });
}

async function getAccessToken(user, pass) {
    /* Make a post request to /auth/login to grab an access token. */
    let url = process.env.COMP_API_BASE_URL;

    const response = await fetch(`${url}/auth/login`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            "username": `${user}`,
            "password": `${pass}`
        })
    });

    const data = await response.json();
    return data.access_token;
}

/* Includes only Available + Inbound, every quantity except unfullfillable. */
async function getSkusOnhand(sku_groups, access_token) {
    const sku_list = Object.keys(sku_groups);    // all the skus in our sku_groups as an array
    const size = 50;
    const result = {};  // { SKU123: 142, SKU456: 80 }

    /* Grab 50 skus from sku_list, get their inventory summaries, and push
        the sku + quantity into result. */
    for (let i = 0; i < sku_list.length; i += size) {
        let data = await getInventorySummary(sku_list.slice(i, i + size), access_token);
        data.payload.inventorySummaries.forEach(product => {
            let qtys = product.inventoryDetails;
            let total = qtys.fulfillableQuantity +
                qtys.inboundWorkingQuantity +
                qtys.inboundShippedQuantity +
                qtys.inboundReceivingQuantity +
                qtys.reservedQuantity.totalReservedQuantity +
                qtys.researchingQuantity.totalResearchingQuantity;

            result[`${product.sellerSku}`] = total;
        });
    }

    return result;
}

/* SKU list constraints: <= 50 SKUs */
async function getInventorySummary(skus, access_token) {
    if (skus.length > 50) {
        console.error('requested sku list exceeds SP-API\'s max sku list limit of 50!');
        return undefined;
    }

    const url = `${process.env.COMP_API_BASE_URL}/sp-api/request`;
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${access_token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            "method": "GET",
            "path": "/fba/inventory/v1/summaries?details=true" + 
                    `&granularityType=Marketplace&sellerSkus=${skus.toString()}` +
                    `&marketplaceIds=${process.env.MARKETPLACE_ID}` +
                    `&granularityId=${process.env.MARKETPLACE_ID}`
        })
    });
    const data = await response.json();

    return data;
}

async function getSalesVelocity(skus, access_token) {
    let data = await getOrderMetrics(skus, access_token);
    for (const [sku, value] of Object.entries(data)) {
        data[sku] = value.payload[0].unitCount / 60;    /* Magic number: 60 days */
    }
    return data;
}

/* Get the sales velocity information for each sku in the skus list.
    Returns an object with sku keys, and sales velocity object as values. */
async function getOrderMetrics(skus, access_token) {
    const result = {};
    const url = `${process.env.COMP_API_BASE_URL}/sp-api/request`;
    let response;
    let data;

    /* Sales metric information the past 60 days. */
    const end = new Date(); // now
    const start = new Date(end - 60 * 24 * 60 * 60 * 1000); // 60 days ago

    const interval = `${start.toISOString()}--${end.toISOString()}`;
    // e.g. "2026-07-21T23:14:00.000Z--2026-09-19T23:14:00.000Z"

    for (let sku of skus) {
        await delay(2100);  // 1 request every 2 seconds.

        response = await fetch(url, {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${access_token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                "method": "GET",
                "path": `/sales/v1/orderMetrics?marketplaceIds=${process.env.MARKETPLACE_ID}` +
                        `&interval=${interval}&granularity=Total` +
                        `&sku=${sku}`
            })
        });
        
        data = await response.json();
        result[`${sku}`] = data;
    }

    return result;
}

async function test_seller_central_api() {
    /* Make a POST request to /auth/login to grab an access token. */
    const access_token = await getAccessToken(
        process.env.COMP_API_USER,
        process.env.COMP_API_PASS
    );

    if(!access_token) {
        console.log("Couldn't retrieve access token!");
        return;
    }

    /* TODO: Use access token to interact with Seller Central API. */

    /* TEST: Try to use getOrderMetrics to grab sales velocity info for
        a particular SKU. */
    const result = await getOrderMetrics(['QF-E0M1-215T', 'FM-VEWR-D8O5'], access_token);
    console.dir(result, {depth: null, colors: true});
}

// test_seller_central_api();

main();