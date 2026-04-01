s = open("assets/index-8920794d.js", encoding="utf-8", errors="ignore").read()
i = s.find("lh=()=>")
print("lh=()=>", i)
if i > 0:
    print(s[i : i + 200])
i2 = s.find("const lh")
print("const lh", i2)
if i2 > 0:
    print(s[i2 : i2 + 300])
