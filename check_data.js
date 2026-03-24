const urlRecent = "https://iizjhnhnpsvaylcdgish.supabase.co/rest/v1/telemetry?order=created_at.desc&limit=5&select=*";
const key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlpempobmhucHN2YXlsY2RnaXNoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQxODc5NzYsImV4cCI6MjA4OTc2Mzk3Nn0.1fUlPcWCmDuXiupHM3m4-7uhSSD-wtaW80XeYdtdlf4";

async function check() {
  try {
    const res = await fetch(urlRecent, {
      headers: { "apikey": key, "Authorization": `Bearer ${key}` }
    });
    const data = await res.json();
    console.log(`Found ${data.length} RECENT records.`);

    if (data.length > 0) {
      console.log("Latest records:", JSON.stringify(data, null, 2));
    } else {
      console.log("Table is EMPTY or RLS blocked.");
    }
    
    require('fs').writeFileSync('recent_telemetry.json', JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(e);
  }
}

check();
