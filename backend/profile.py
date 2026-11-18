"""Candidate profile used for "match score" (embedding similarity) and preferences.
Derived from the resume; editable from the UI (Profile dialog), which stores an override in the DB."""

DEFAULT_PROFILE = """Target roles: undergraduate co-op / internship in content creation, marketing, and UX/UI design.
Content creation: short-form video production and editing (Adobe Premiere Pro, DaVinci Resolve, CapCut, Videoleap), social media content, visual storytelling, multilingual content, graphic design with Photoshop, Illustrator and Canva.
Marketing: digital marketing, social media marketing, brand marketing, campaign assets, posters, brochures, product graphics, promotional videos, marketing communications for domestic and international audiences.
UX/UI design: website layouts, product pages, information hierarchy, navigation, Figma, Adobe XD, Framer, Wix, prototyping, user flows, personalized recommendation flows, AI-assisted prototyping.
Education: University of Waterloo, Bachelor of Global Business and Digital Arts (GBDA), expected graduation April 2028.
Experience: Marketing & Design Co-op Intern at CMA Global; Media & Content Support at CJ ENM.
Languages: Korean (native), English (fluent), Chinese (fluent, HSK 6), Spanish (conversational)."""

PREFERENCES = {
    # Ontario first; Waterloo Region + GTA get an extra boost.
    "homeCities": ["waterloo", "kitchener", "cambridge", "guelph"],
    "gtaCities": ["toronto", "mississauga", "markham", "vaughan", "richmond hill", "oakville", "brampton", "north york", "etobicoke", "scarborough", "burlington"],
    # Study permit + co-op work permit (no PR/citizenship).
    "workAuth": "coop-permit",
    "targetTerms": ["Winter 2027", "Summer 2027", "8-month"],
}

# Compared against job titles for the "role fit" half of Match %.
TARGET_ROLES = "Content creator, social media coordinator, video editor, digital marketing, brand marketing, marketing communications, creative/graphic designer, UX/UI designer, product designer, web designer"
