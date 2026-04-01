s = open("assets/index-8920794d.js", encoding="utf-8", errors="ignore").read()
i = s.find('Sq="/user",Pq=')
print(s[i : i + 4000])
