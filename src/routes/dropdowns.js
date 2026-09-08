const router   = require("express").Router();
const userAuth = require("../middleware/userAuth");

// GET /api/dropdowns
router.get("/", userAuth, (_req, res) => {
  res.json({
    success: true,
    data: {
      profileManagedBy: ["Self", "Parents", "Siblings", "Friends", "Others"],

      religions: ["Hindu", "Muslim", "Christian", "Sikh", "Buddhist", "Jain", "Other"],

      castes: {
        Hindu:    ["Brahmin", "Kshatriya", "Vaishya", "Shudra", "Nair", "Nadar", "Chettiar", "Mudaliar", "Pillai", "Gounder", "Naidu", "Reddy", "Iyer", "Iyengar", "Other"],
        Muslim:   ["Sunni", "Shia", "Bohra", "Memon", "Pathan", "Syed", "Sheikh", "Ansari", "Other"],
        Christian:["Catholic", "Protestant", "CSI", "Pentecostal", "Baptist", "Orthodox", "Other"],
        Sikh:     ["Jat Sikh", "Khatri", "Arora", "Ramgarhia", "Mazhabhi", "Other"],
        Buddhist: ["Ambedkarite", "Theravada", "Mahayana", "Zen", "Other"],
        Jain:     ["Digambara", "Shvetambara", "Other"],
        Other:    ["Other"],
      },

      subCastes: ["Not Applicable", "Other"],

      nakshatrams: [
        "Ashwini","Bharani","Krittika","Rohini","Mrigashira","Ardra","Punarvasu",
        "Pushya","Ashlesha","Magha","Purva Phalguni","Uttara Phalguni","Hasta",
        "Chitra","Swati","Vishakha","Anuradha","Jyeshtha","Mula","Purva Ashadha",
        "Uttara Ashadha","Shravana","Dhanishta","Shatabhisha","Purva Bhadrapada",
        "Uttara Bhadrapada","Revati","Don't Know",
      ],

      heights: [
        "4'6\"","4'7\"","4'8\"","4'9\"","4'10\"","4'11\"",
        "5'0\"","5'1\"","5'2\"","5'3\"","5'4\"","5'5\"","5'6\"","5'7\"","5'8\"","5'9\"","5'10\"","5'11\"",
        "6'0\"","6'1\"","6'2\"","6'3\"","6'4\"","6'5\"",
      ],

      weights: [
        "40 kg","45 kg","50 kg","55 kg","60 kg","65 kg","70 kg","75 kg",
        "80 kg","85 kg","90 kg","95 kg","100 kg","105 kg","110 kg+",
      ],

      complexions: ["Very Fair","Fair","Wheatish","Wheatish Brown","Dark","Other"],

      educations: [
        "High School","Diploma","Bachelor's Degree","Master's Degree",
        "MBA","PhD","MBBS","BE/BTech","ME/MTech","CA","Other",
      ],

      occupationTypes: [
        "Government Employee","Private Employee","Business/Self-Employed",
        "Doctor","Engineer","Teacher/Professor","Lawyer","Architect","Accountant",
        "IT Professional","Defence","Police","Not Working","Other",
      ],

      fatherOccupations: [
        "Business","Government Employee","Private Employee","Farmer",
        "Doctor","Engineer","Teacher","Retired","Expired","Other",
      ],

      motherOccupations: [
        "Homemaker","Business","Government Employee","Private Employee",
        "Teacher","Doctor","Retired","Expired","Other",
      ],

      siblings: ["0","1","2","3","4","5+"],

      annualIncomes: [
        "Below 1 LPA","1-3 LPA","3-5 LPA","5-7 LPA","7-10 LPA",
        "10-15 LPA","15-20 LPA","20-30 LPA","30-50 LPA","50 LPA+",
        "Not Disclosed",
      ],
    },
  });
});

module.exports = router;
