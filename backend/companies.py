"""Seed list of public job boards that hire in Canada/Ontario (checked 2026-11-16).
Add more via the "Dream company" box in the UI, which saves them to the database.
  ats: greenhouse | lever | ashby | smartrecruiters | workday | workable | avature
  slug: board token (workday: "<tenant>.wdN"), site: workday site id
"""

SEED_COMPANIES = [
    {"name":"RBC","ats":"workday","slug":"rbc.wd3","site":"RBCGLOBAL1"},
    {"name":"TD Bank","ats":"workday","slug":"td.wd3","site":"TD_Bank_Careers"},
    {"name":"Manulife","ats":"workday","slug":"manulife.wd3","site":"MFCJH_Jobs"},
    {"name":"Sun Life","ats":"workday","slug":"sunlife.wd3","site":"Campus"},
    {"name":"CIBC","ats":"workday","slug":"cibc.wd3","site":"search"},
    {"name":"BMO","ats":"workday","slug":"bmo.wd3","site":"External"},
    {"name":"Wealthsimple","ats":"ashby","slug":"wealthsimple"},
    {"name":"1Password","ats":"ashby","slug":"1password"},
    {"name":"Cohere","ats":"ashby","slug":"cohere"},
    {"name":"Jobber","ats":"ashby","slug":"jobber"},
    {"name":"Lightspeed","ats":"ashby","slug":"lightspeedhq"},
    {"name":"Neo Financial","ats":"ashby","slug":"neofinancial"},
    {"name":"Hopper","ats":"ashby","slug":"hopper"},
    {"name":"Trulioo","ats":"ashby","slug":"trulioo"},
    {"name":"Benevity","ats":"ashby","slug":"benevity"},
    {"name":"Thinkific","ats":"ashby","slug":"thinkific"},
    {"name":"Indigo","ats":"ashby","slug":"indigo"},
    {"name":"D2L","ats":"greenhouse","slug":"d2l"},
    {"name":"Geotab","ats":"greenhouse","slug":"geotab"},
    {"name":"Questrade","ats":"greenhouse","slug":"questrade"},
    {"name":"StackAdapt","ats":"greenhouse","slug":"stackadapt"},
    {"name":"Flipp","ats":"greenhouse","slug":"flipp"},
    {"name":"Ritual","ats":"greenhouse","slug":"ritual"},
    {"name":"Hootsuite","ats":"greenhouse","slug":"hootsuite"},
    {"name":"Later","ats":"greenhouse","slug":"later"},
    {"name":"Sprout Social","ats":"greenhouse","slug":"sproutsocial"},
    {"name":"PointClickCare","ats":"lever","slug":"pointclickcare"},
    {"name":"Achievers","ats":"lever","slug":"achievers"},
    {"name":"Fullscript","ats":"lever","slug":"fullscript"},
    {"name":"Knix","ats":"lever","slug":"knix"},
    {"name":"Pelmorex (The Weather Network)","ats":"lever","slug":"pelmorex"},
    {"name":"Wattpad","ats":"lever","slug":"wattpad"},
    {"name":"Wave","ats":"lever","slug":"waveapps"},
    {"name":"Canva","ats":"smartrecruiters","slug":"canva"},
    {"name":"Ubisoft","ats":"smartrecruiters","slug":"Ubisoft2"},
    {"name":"Pinterest","ats":"greenhouse","slug":"pinterest"},
    {"name":"Reddit","ats":"greenhouse","slug":"reddit"},
    {"name":"Instacart","ats":"greenhouse","slug":"instacart"},
    {"name":"Faire","ats":"greenhouse","slug":"faire"},
    {"name":"Dropbox","ats":"greenhouse","slug":"dropbox"},
    {"name":"Airbnb","ats":"greenhouse","slug":"airbnb"},
    {"name":"Coinbase","ats":"greenhouse","slug":"coinbase"},
    {"name":"Discord","ats":"greenhouse","slug":"discord"},
    {"name":"Epic Games","ats":"greenhouse","slug":"epicgames"},
    {"name":"Spotify","ats":"lever","slug":"spotify"}
]


def company_key(c: dict) -> str:
    site = c.get("site")
    return f"{c['ats']}:{c['slug']}{'/' + site if site else ''}".lower()
