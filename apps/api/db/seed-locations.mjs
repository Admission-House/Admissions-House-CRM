// Loads the states, union territories and principal cities of India into the shared places list.
// Safe to run again: what exists is left alone and only what is missing is added.
//
//   node --env-file=.env db/seed-locations.mjs
//
// The list is the places a counsellor picks from (a student's city, a college's city). Add more cities
// to the arrays below as they are needed; nothing else has to change.

import pg from 'pg';

const PLACES = {
  'Andhra Pradesh': ['Visakhapatnam', 'Vijayawada', 'Guntur', 'Nellore', 'Kurnool', 'Rajahmundry', 'Tirupati', 'Kakinada', 'Kadapa', 'Anantapur', 'Eluru', 'Ongole'],
  'Arunachal Pradesh': ['Itanagar', 'Naharlagun', 'Pasighat', 'Tawang'],
  Assam: ['Guwahati', 'Silchar', 'Dibrugarh', 'Jorhat', 'Nagaon', 'Tinsukia', 'Tezpur'],
  Bihar: ['Patna', 'Gaya', 'Bhagalpur', 'Muzaffarpur', 'Purnia', 'Darbhanga', 'Arrah', 'Begusarai', 'Katihar', 'Munger'],
  Chhattisgarh: ['Raipur', 'Bhilai', 'Bilaspur', 'Korba', 'Durg', 'Rajnandgaon', 'Jagdalpur'],
  Goa: ['Panaji', 'Margao', 'Vasco da Gama', 'Mapusa', 'Ponda'],
  Gujarat: ['Ahmedabad', 'Surat', 'Vadodara', 'Rajkot', 'Bhavnagar', 'Jamnagar', 'Gandhinagar', 'Junagadh', 'Anand', 'Navsari', 'Morbi', 'Mehsana', 'Bharuch', 'Vapi'],
  Haryana: ['Gurugram', 'Faridabad', 'Panipat', 'Ambala', 'Yamunanagar', 'Rohtak', 'Hisar', 'Karnal', 'Sonipat', 'Panchkula', 'Bhiwani', 'Sirsa', 'Kurukshetra', 'Jhajjar'],
  'Himachal Pradesh': ['Shimla', 'Solan', 'Dharamshala', 'Mandi', 'Baddi', 'Kullu', 'Hamirpur', 'Una'],
  Jharkhand: ['Ranchi', 'Jamshedpur', 'Dhanbad', 'Bokaro Steel City', 'Deoghar', 'Hazaribagh', 'Giridih'],
  Karnataka: ['Bengaluru', 'Mysuru', 'Hubballi', 'Mangaluru', 'Belagavi', 'Kalaburagi', 'Davanagere', 'Ballari', 'Shivamogga', 'Tumakuru', 'Udupi', 'Vijayapura', 'Hassan'],
  Kerala: ['Thiruvananthapuram', 'Kochi', 'Kozhikode', 'Thrissur', 'Kollam', 'Kannur', 'Alappuzha', 'Palakkad', 'Kottayam', 'Malappuram', 'Pathanamthitta'],
  'Madhya Pradesh': ['Indore', 'Bhopal', 'Jabalpur', 'Gwalior', 'Ujjain', 'Sagar', 'Dewas', 'Satna', 'Ratlam', 'Rewa', 'Katni', 'Singrauli', 'Chhindwara'],
  Maharashtra: ['Mumbai', 'Pune', 'Nagpur', 'Thane', 'Nashik', 'Aurangabad', 'Solapur', 'Kolhapur', 'Amravati', 'Navi Mumbai', 'Sangli', 'Jalgaon', 'Akola', 'Latur', 'Ahmednagar', 'Nanded', 'Dhule', 'Satara', 'Ratnagiri'],
  Manipur: ['Imphal', 'Thoubal', 'Churachandpur'],
  Meghalaya: ['Shillong', 'Tura', 'Jowai'],
  Mizoram: ['Aizawl', 'Lunglei', 'Champhai'],
  Nagaland: ['Kohima', 'Dimapur', 'Mokokchung'],
  Odisha: ['Bhubaneswar', 'Cuttack', 'Rourkela', 'Berhampur', 'Sambalpur', 'Puri', 'Balasore', 'Bhadrak'],
  Punjab: ['Ludhiana', 'Amritsar', 'Jalandhar', 'Patiala', 'Bathinda', 'Mohali', 'Pathankot', 'Hoshiarpur', 'Moga', 'Firozpur', 'Phagwara', 'Kapurthala', 'Gurdaspur', 'Sangrur'],
  Rajasthan: ['Jaipur', 'Jodhpur', 'Kota', 'Bikaner', 'Ajmer', 'Udaipur', 'Bhilwara', 'Alwar', 'Sikar', 'Sri Ganganagar', 'Pali', 'Bharatpur', 'Chittorgarh', 'Jhunjhunu', 'Tonk'],
  Sikkim: ['Gangtok', 'Namchi', 'Gyalshing'],
  'Tamil Nadu': ['Chennai', 'Coimbatore', 'Madurai', 'Tiruchirappalli', 'Salem', 'Tirunelveli', 'Tiruppur', 'Erode', 'Vellore', 'Thoothukudi', 'Thanjavur', 'Dindigul', 'Kanchipuram', 'Hosur', 'Nagercoil', 'Karur'],
  Telangana: ['Hyderabad', 'Warangal', 'Nizamabad', 'Karimnagar', 'Khammam', 'Ramagundam', 'Mahbubnagar', 'Nalgonda', 'Adilabad', 'Secunderabad'],
  Tripura: ['Agartala', 'Udaipur (Tripura)', 'Dharmanagar'],
  'Uttar Pradesh': ['Lucknow', 'Kanpur', 'Ghaziabad', 'Agra', 'Varanasi', 'Meerut', 'Prayagraj', 'Bareilly', 'Aligarh', 'Moradabad', 'Saharanpur', 'Gorakhpur', 'Noida', 'Greater Noida', 'Firozabad', 'Jhansi', 'Muzaffarnagar', 'Mathura', 'Rampur', 'Shahjahanpur', 'Ayodhya', 'Etawah', 'Sultanpur', 'Basti', 'Mirzapur'],
  Uttarakhand: ['Dehradun', 'Haridwar', 'Roorkee', 'Haldwani', 'Rudrapur', 'Kashipur', 'Rishikesh', 'Nainital', 'Pantnagar', 'Mussoorie'],
  'West Bengal': ['Kolkata', 'Howrah', 'Durgapur', 'Asansol', 'Siliguri', 'Bardhaman', 'Malda', 'Kharagpur', 'Haldia', 'Darjeeling', 'Krishnanagar', 'Bankura'],

  'Andaman and Nicobar Islands': ['Port Blair'],
  Chandigarh: ['Chandigarh'],
  'Dadra and Nagar Haveli and Daman and Diu': ['Daman', 'Diu', 'Silvassa'],
  Delhi: ['New Delhi', 'Delhi', 'Dwarka', 'Rohini', 'Saket', 'Karol Bagh', 'Janakpuri'],
  'Jammu and Kashmir': ['Srinagar', 'Jammu', 'Anantnag', 'Baramulla', 'Udhampur', 'Kathua'],
  Ladakh: ['Leh', 'Kargil'],
  Lakshadweep: ['Kavaratti'],
  Puducherry: ['Puducherry', 'Karaikal', 'Yanam', 'Mahe'],
};

const url = process.env.MIGRATOR_DATABASE_URL;
if (!url) {
  console.error('MIGRATOR_DATABASE_URL must be set');
  process.exit(1);
}
const db = new pg.Client({ connectionString: url });
await db.connect();

try {
  await db.query('BEGIN');
  let states = 0;
  let cities = 0;
  for (const [state, list] of Object.entries(PLACES)) {
    let id = (await db.query(`SELECT id FROM locations WHERE type = 'state' AND name = $1`, [state])).rows[0]?.id;
    if (!id) {
      id = (await db.query(`INSERT INTO locations (type, name) VALUES ('state', $1) RETURNING id`, [state])).rows[0].id;
      states++;
    }
    for (const city of list) {
      const done = await db.query(`INSERT INTO locations (type, name, parent_id) SELECT 'city', $1, $2 WHERE NOT EXISTS (SELECT 1 FROM locations WHERE type = 'city' AND name = $1 AND parent_id = $2)`, [city, id]);
      cities += done.rowCount ?? 0;
    }
  }
  await db.query('COMMIT');
  const total = (await db.query(`SELECT count(*) FILTER (WHERE type = 'state') AS s, count(*) FILTER (WHERE type = 'city') AS c FROM locations`)).rows[0];
  console.log(`added ${states} states and ${cities} cities; the list now has ${total.s} states and ${total.c} cities`);
} catch (err) {
  await db.query('ROLLBACK');
  console.error('failed, nothing was saved:', err.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
