s = open("assets/index-8920794d.js", encoding="utf-8", errors="ignore").read()
for needle in ["access_token", "setItem(", "token", "lh=function", "lh=()"]:
    idx = 0
    while True:
        i = s.find(needle, idx)
        if i < 0:
            break
        if needle == "setItem(" and "token" not in s[i : i + 80]:
            idx = i + 1
            continue
        print(needle, i, s[i : i + 120].replace("\n", " "))
        break
        idx = i + 1
