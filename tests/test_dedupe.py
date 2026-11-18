from backend.dedupe import company_norm, merged_state, plan_merges, title_norm


def job(id, source, company="EastGen Incorporated", title="Marketing Intern (Summer 2027)", cities=("Guelph",),
        mode="hybrid", status="none", notes="", review="", first="2026-11-01", dream=False):
    return {
        "id": id, "source": source, "company": company, "title": title, "workMode": mode,
        "location": {"cities": list(cities)}, "app": {"status": status, "notes": notes, "deadline": ""},
        "review": review, "firstSeen": first, "dream": dream, "manual": False, "active": True,
    }


def ids(plans):
    return sorted((keep["id"], sorted(d["id"] for d in dups)) for keep, dups in plans)


def test_normalizers():
    assert company_norm("EastGen Incorporated") == company_norm("EastGen") == "eastgen"
    assert company_norm("Acme, Inc.") == "acme"
    assert title_norm("Graphic Designer Intern (Remote)") == title_norm("Graphic Designer Intern - Remote") == "graphicdesignerintern"


def test_same_role_on_two_sites_merges_into_company_board():
    plans = plan_merges([job("indeed:1", "indeed", first="2026-10-01"), job("greenhouse:9", "greenhouse", company="EastGen")])
    assert ids(plans) == [("greenhouse:9", ["indeed:1"])]


def test_two_boards_keep_the_oldest():
    plans = plan_merges([job("eluta:2", "eluta", first="2026-11-10"), job("indeed:1", "indeed", first="2026-11-01")])
    assert ids(plans) == [("indeed:1", ["eluta:2"])]


def test_same_source_is_never_merged():
    # RBC lists "Banking Advisor Intern" once per branch; Manulife has two requisitions with one title.
    assert plan_merges([job("workday:a", "workday"), job("workday:b", "workday")]) == []


def test_different_cities_stay_separate():
    plans = plan_merges([job("workday:a", "workday", cities=["Toronto"]), job("linkedin:1", "linkedin", cities=["Vancouver"])])
    assert plans == []


def test_unknown_or_remote_location_overlaps():
    plans = plan_merges([job("lever:a", "lever", cities=["Toronto"]), job("linkedin:1", "linkedin", cities=[])])
    assert ids(plans) == [("lever:a", ["linkedin:1"])]
    plans = plan_merges([job("lever:a", "lever", cities=["Austin"], mode="remote"), job("linkedin:1", "linkedin", cities=["Remote"], mode="remote")])
    assert ids(plans) == [("lever:a", ["linkedin:1"])]


def test_board_copy_joins_only_one_of_two_ats_requisitions():
    plans = plan_merges([job("workday:a", "workday", first="2026-01-01"), job("workday:b", "workday", first="2026-02-01"), job("linkedin:1", "linkedin")])
    assert ids(plans) == [("workday:a", ["linkedin:1"])]


def test_tracking_and_review_state_carry_over():
    keep = job("greenhouse:9", "greenhouse", review="pending", dream=True)
    dup = job("linkedin:1", "linkedin", status="applied", notes="Referral: Sam", review="")
    st = merged_state(keep, [dup])
    assert st["app"]["status"] == "applied" and st["app"]["notes"] == "Referral: Sam"
    assert st["review"] == ""  # it was already in the hub, so it stays in the hub
    assert st["dream"] is True
    st = merged_state(job("a", "lever", notes="Mine"), [job("b", "linkedin", notes="Theirs")])
    assert st["app"]["notes"] == "Mine\nTheirs"
    assert merged_state(job("a", "lever", review="pending"), [job("b", "linkedin", review="dismissed")])["review"] == "dismissed"
