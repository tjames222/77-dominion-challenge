<script setup lang="ts">
import HeroSection from './components/HeroSection.vue';
import DailyChecklist from './components/DailyChecklist.vue';
import CommunityFeed from './components/CommunityFeed.vue';
import ProgressRing from './components/ProgressRing.vue';
import { useChallenge } from './composables/useChallenge';
import { useCommunity } from './composables/useCommunity';
import { useTheme } from './composables/useTheme';

const challenge = useChallenge();
const community = useCommunity();
const theme = useTheme();
const dominionPoster = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAsICAoIBwsKCQoNDAsNERwSEQ8PESIZGhQcKSQrKigkJyctMkA3LTA9MCcnOEw5PUNFSElIKzZPVU5GVEBHSEX/2wBDAQwNDREPESESEiFFLicuRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUVFRUX/wAARCADwAWgDASIAAhEBAxEB/8QAGwAAAQUBAQAAAAAAAAAAAAAAAAECBAUGAwf/xABMEAABAwMCBAIIAQcJBgQHAAABAAIDBAUREiEGMUFRE2EHFCIycYGRobEVI0JSYsHhFjM2N3Ky0fDxFyc0Q3OCdKKzwiRUVWODkpP/xAAZAQEAAwEBAAAAAAAAAAAAAAAAAQIDBAX/xAAmEQEBAAICAgIBBAMBAAAAAAAAAQIRAyESMRNBUQQyYcEicYFC/9oADAMBAAIRAxEAPwDyNCEKUBCEIBCVCAQhCBUIQgVCEIFShCEDwurea5BPaUHUpwTQcpQVA7NdsnatlxBTwUSeBkp4IXLVnklBxzQdMpHP2wEwuTHHogY4ph3SuzlIApQEEgDLjgJwY4jOM/BcmjxZwNWlrdy7GdIUGlhDcRQRBwgj1uGWNeNRx3P+CiGaWpm1l5zz26fJR3kSPc/2jvgEnc/FSYxTQ05Mh1SHljkPkq6W20lDdI6fwmYdHVMHsvLtgOudJyotc8xO1xVRqZtJk0MY72fiD065VbHdIY5HGKmY3JBxjJOOQU+O5Qvpmw1To4YHuLpGNJy8/tYyT9uirpfZkMVLci2CaDwpnjLZ4xu077OaOYz1VTW0EtBN4cuCP0XtOQ4eRVwZPWKioqYnElughujRhpIAa34DGCu07BXCrppGnxA0yxuJ1HUOx7EfcKZdIs3GYSJxCQhaMzSmpyaUCIQhAiEIQCEIQIhCEAhCEAlSIQKhIlQCVIhAqEIQKlSJUCoCRKEQcE8JgTgUSflKCmZSoH6t09r+65ApwQdc9kZyd00E8kOPZQHFyTOyZlO6IESg90mUKRJbhtFI9o9rOM/JRKCYRVAJbljwWHbmpTN6GbbfIAUGQGOZkbN3M/FV/K34cnSHfbfJJKbuTvyQQRz2Q1xachWVdGe9huR81Iinjjla58esMPLbmojXuY7IxnzC7tqpcgtbGwt6hgyoqVjV1MpDZpmhjpmlugE5bgjDj58/opdvqXm8RzSD84ZQ2Qd8nn898qmm1l0bpnF7pG8s8sqZQnFa0E/nGuxjy2IKpZ0tL2hVEfhVMsf6j3N38iuZVjfYxHfK1rRgeKTzzz3/AHqtKvPSl9mlNTimqQ0oSlIgRCEIBIlQgRCEIBCEIBCEIBKhCASpEqASpEqASpEZQKnBNTggUJUgSoBO6JqMoHApwKZlKEHXVlCYClDkD8JMlGdk1A7JKAUmUBBPZDJHb3SSBuiUgsGrc4JGcdsjGVWuLYw8j845x2k6DvhWNKRLTuY9x/NbsGMjDjg/fBUOq0ACNgJe0lziehVJ7Xs6iIW6sFpycb/FNBc3Y7BDveJBSl2puDzV1D3tLCA7kdwW9UjXNAwBklMbI5u2cjsRldWPLjpDG79mqEnye0xmd5HO97yVrZGCSsZI4e4CXn4KqdkuOxc/PM7Y8lfUFM8UcbQ4MfVO0gu2wOpP0Vcr0tjO0utZb/CvD6inNRVF50VDZDiI7kctjsOqyhWkpaEhkrKoSRQTRmNpB3e5rsnyzlpSNsFuexx9aqQQ7AOlp2H8cj5KML12tyyS6jNEJpCv5+HWtBMNfEW4yNbSCcjPTKgXKx3C1aTWU0jGOALZNJ0n5q+4y1VckKUhIVIRIlQgRCVIgRCEIBCEIBbGPgF0kbXflADU0HHg9x8Vjl6zFeLe2CPNdTZDACPFHZc/Pnnjrxb8WOOW/Jmf9n7v/qI//j/FNPAWkEuuIDRuT4Ow+6sKjjijp6mSIU8sgY4t1se3DvMLQQzmanjkMZYXsDi0ncZHJc95ObHutZhx30854g4fNiEBNSJ/F1cmacYx5+atYuBDJEx5uABe0HHhdxnuo/G1cyetgpo8EQsLnHzd0+gH1WuprtbxSxA11PqDG5zKOy0y5OSYY37UxwwuVjOjgE9biB/+L+Ka/gTQCXXAADr4P8VPquNqOnqZImwSyhjiPEY5uHeYV/DVGalhm8N0ZlaHBp3Lcjqs7yc2Pd/peYcd9PPr9w6bHFA/1oTiZxAwzTjA+Ko1qeNK4Sz01I3H5ppe7Hc8vsFll2cVyuEuTm5JJlqFShIlC0UOSpoTkAjCUFBKAylCbhKgU7FKCkSoOmchJhNCnW62VFykc2BoDWDMkj9msHmfwHVRbpMm0PTup9rtM9ykwwiOJvvyuB0j4dz5BbK08LW6GDxJmuqpAM6pGkNH/b/jlcrq6t/Jr5ba1r4I3fnBGN2jyHQBYXm31i3nDZ3kgXCitlltzBHE6aolJa6aR3tBo56QNgq2otzKmV08LSAXEDl7XUfPCrbhUvqGDU4kgE7qz4XnE75qKRwHjNa9jnHZrhsp1Zjv7RuXLX0z01OR7Tc4+HJcDtzV9caUwzSNwC0PILhuAqh0ZDiMAkea0xy2zyx04DB5rvGSMBhc3v7SaGYXZkedycKbUSJdBEJJS0DUSR+K2dTahFRUtQ57dcLXamnlkjYLN2J1NS1fjVm8AHtD/DzV+bg6vpoZXt0eNOC0HowbD9ywyt23xk0zl1rpad8NH4mW0+HAh2QS7BKji5actB6l2PPJwqueQvmcScnP4Jhz4p+K3xmpIwyu8rWnsMsdZfKdk/8Aw8R1v8wP44Xqcr2VEBMM7KmJ2z2OwSPkvErdM+DW5hOp+2y09n/KENXE+WV9NGSCCQcn5LHk9tuKdLG9+j+Coe6a0VETJCd4S72fkeiw1wtVbapjFW074XdC4bH4HkV6RVX03Cq8AxU8YGzpAzBPmplZaDTUpEhhq6aUDAdv9FXHlsWy4pf4rx7CFpL/AMOCjidWUId4Df52I7mPPUdx+Cza6McplNxzZY3G6pCkSpFZBEJUIEQhCAQhKgsLDQ/lC8U8BHsatT/gN/4L1CZwZE973ABrSSTywOayPBFDiKarcBl58Nmew3J+uFZcXVpprO9rX4dOfDA8uZ+34rg5r58kxjr4/wDHDyrBVtU6trZqh/ORxd8B0H0XHCELvk105LU20URuFzp6ccnOy7yA3K9TeGtblzsNwc56DCxvBFEdU9Y7YfzbT9z+5XXFNd6pZZwHe3KRE358/tlcHPfPkmMdfFPHDyrA3CqNbXz1B5PcSPIdPsrG0cJXi+0jqm20omha8sLjI1uCADyJ8wqVesejyd9N6PrpNE7TJFJO9rh0IjaQu71NRy+68+u/DF3sUbJLlRPiiedIkBDm57ZB2K5Wex19+qJILbB40kbNbgXhuBnHM+ZXpZr6i++iOsq7i9ss5jfl2kDJa8YOB1VX6KY2wtvNdJ7kTGNz5buP4BNmmOfw3dIr4yzvpwK9+NMfiNwcjI3zjkifh25015itM1NprpdOiPWDnPLfOFr/AEhSutPHFsuke2I45MjroeQfstdW2ptT6QbPcmN1MFJKc+bfd/8AUTZp5PJwpeIrxHajRk1sjBII2va7De5IOANuqkXXge+WajdV1VK0wM998Ugfo8yB0816BwpXMufpD4jn1AtYxsTD+w1wbt9FxtvEgltvElHfrhE2ds00UMVQ8Ndp0kaQO2cJs08lSjdNHuj4JQVKCpwTQnA4KDvS08tXUx08DC+WVwYxo6krfVnq1htjKGEteynOZXDcSzEbuPfHRVfA9H4frd2czU6BvhU//UcNz8h+Kg36r1yinadmn2sd1jnd3TbjmptpuF734tS81BBaGkBpXGlr4/yjUyRP0xHI0jkd1mqCsdQskcwDUQRkopJTktyWtdsSOmVjcW8yXHEdkgmtwulJ4bTGdMjGnm122ceRP3WJoqk0lS2TGQzYjuDsR9Fpq+d7LdMxztTdGAc9iFkHH23ea34u8dOfl6y2u6uokDyM+JG4bHqR0PmoDzHI4GMnJG7cdV0t08cuKSpPsH+bf+qe3wUqnifDc4oAwuJcG6W8znb96euk/u7V7mmIkPaWnGcEdE0ynHstOe55K3vcUjbwW4ByxuAB0xhVUrHMeA5uARt5qZdos1dHRPy5urJP4q6qa8xxxwt9lzG5wOn+dlAiEVPRSTOafEGnGdufJQpJ3Fri45e/mVGvKp34xG9547lH6Tilj/nW/FJ+kR3K1Ytfw/BS0dM2ona107hkZ/R/ir0XKGalma8AyHcHqFj4Z3BoGeSksnIeHZXHljbd1245STUJTVUgdJg7F2+Vp4ri2a3R6CdTNi3OVkYjiV2/Mq1pJhG0g/6KbESthY5qe4tdR1Aa50jXMO3MFeXXy2OtF2qKRwIDHeznq3otfbK001bHIx2C1wI3zlO9JtJHJJS3GEbPaGuKvx3XTPlm3nqROKauhzkKEpQgahCEAlaC5wDRknYBIrfhqi9dvMIc3UyL844fDkPrhRlfGWpk3dN/aqMW+2QU4x7DRqx35n7rGcZVoqLmynYcsp2Y/wC47n9y3csrKeB0khw1jS5x8hzXk9VUOq6qWd5OqV5cc+a4v088srlXTzXWMxjmgJFZ2CjFbd4GOGY2HxH/AAH8cLtyuptzSbum9stD6haoYcfnGtBdn9Y7n8VluM60zXCOmDjphGojzP8ABbZ7mxsJc72WDJPlzK8rrqo1lbPUH/mPLh5Dp9lxfp55Z3KunmvjjMY4L1XgL+rm85HWo/8ASC8qXrHo8hfP6PrtFE0ukkfOxrR1JiAAXbXLHK0f1L1eesc398LhwqDQ+i2+1fJ0pkAPwaGj7kqwjoamy+iGsprhEYJxFJljiMjU8YXe0VNBYvRlRzXSn8emlGXxBodrL3kjY7dB9FCVT6UoxUWux143DmlpcP2mtcPwK01gvbD6P4brIdUlJSPa555hzNvvhqqON5Ke7+jmmr6KIxUzZI5I2EAaW7sxgKNYh/uduWP1Z/7wT6GI4a4hn4evkdwAMgdls7M7yNJyfnncea3HHNhpL9aBxNZyHv8ADD5dP/NYP0sdHN6+Q8lVei+22+5XC4MuFLBUhkbHMbM0Ox7RBI+y0nCVBV2vhy/Q3Cnkgj8WYxskGBp0HJHkppHkKAp7rHcorNHdX0jxQvwGzahg5OBtnPMHoq9Sg7oj4oylAycd0HpdsjbbuEYC72cBpP7T3+0c/LAWDq5jJPI7q5xWvvNRo4XpIgcB8hcB5DYLEyu1OWE77b3rp3EnsBqkRzhjsv3/ABVdrwjxCpuJMtJtfU66R7RyKoyp0h1U789lBV8JqKcl3QNlbR3CWo8ItkEc0ZzqPU98qpStcWnIVrNqy6aCsuBkuEVTMzQ5rG6mg9Rzx8VUyTPlmdK7DckkDsmyVAlY3VnUFzdIMADdVmOlrltLqayWrYzxXezGMAf5+f1UEnJyguLufJJ1VpNKW7K04eCkHMfFA5pRyUoWgy0roJCAuc7hnLdgQuGsg81jrbfenYTFr/JTIZsj9yrC/JzyK7wy6UsJktop9EuR8cK74mm9c4Xj1HJYzP0IWXjkIcDyVzXSGawvZ7xETiMf57Knqr3uMWkKUpMLpcpChKUIGoSIQCtbNfHWbxjHTxyulxlziRgDpsqpXk1gbHw3FdGSuc92C5hAwBkj/BUz8day+18d+463Di6or6KWm9XjiEgwXNcScLPq/reG2w1ttpqeZznVrckvA9nl2VjNwfRujqI6Ouc+rgblzHY54yAQOWVnjnx4Tr7WuOeV7Y9WlnvLrO+Z8cDJXSgNy4kYA32wqwL0mt9HNjt9OH1d+dBI6MvYyXQ3XgdMnfdbZSWarOWy7jL13F9TWUctP6vHGJW6S5rjkBZ5a6Xg2GThe03WiqZJZK2dkEjHNAbG5xLdvmPup7vR7BJxk2x0tdI6OODx6iZ7BlozsAB1OR9VXHHHHrFOVuXtg1f2TjO7cP0TqS3vhbC6QyEPiDjkgDmfgFdcScDUFDYZbrZLi6sippNEwfg43wcEdQSNvNFdwFTUlz4fpG1szm3X33OYMx+yDt35q21VFe+L7xf4RBX1IMAOrwo2BjSe5A5ptfxVcrjZae0zviFHT6NDWRgH2RgZPXmtBSej6Oq4wr7UK17KOhYySSctGs6gCAByHM7+S48T8GUNts9Pd7NcXVlFLIInF2DzJGQRz3BCdCm/lVcjw7+Qi6I0OMaTENXvave+KKbiq5Uthls0T4hRShwcDGC72jk7rXXX0d2S000jqi/OimETpI4pdDTIQDjG/fZcLF6P7dU2Wirr1c30slwIFPGzSNz7oyeZOOSdHbHWi81tjrm1lvl8KYAtORkOB5gjqFc3bj+9XiifRyvhhhkGJBAzSXjsSSdvgqziOyP4evc9ufIJRHhzJMY1NIyDjoVVqRby8S3CewRWV7ovUoiC0CMB2xJ974lVKRKgVd6Snkq6qKCIZfI4NC4LW8JW9sML7lUABrgWMz0Z+m75+6Pmq5XUTjN3Rt4mLrdSg59kHr5lZt5ySVpuJ5qJ8sYt5BgDMNA/R+KzRjc45A+Syx6bZduWUmpEjHNOCCCOhXEuIK0jN3lfinx3KirrM7Olo6Bclaelcr2EIQpQEBKEZCAKTolKRAqAl09yEhQTBJqhaewwkzkZUeJ+MtPI/Yp8ZJeW52VLGkroRlPjOClbGXDb6Jzad/bKjadOzHcsLb8NW78pRE6Q5rI3ZB65GMfdYunppZXhrGnK19iqprVLGXHS3OCB1CyysaYysBW0rqKslp3843FvxHRR1s/SJbWU11ZWQgCKpbnb6/4rGLoxu458pqhCEKUGpEIQC9Ct8IquDI6ckZlp3hue4JIXny3NDUiks9hkd7rptDvg7UFz/qPU024vddKo6r9w8eX5o/3V0tv9Kb5n9Rn4JboA3imyt6ASDHyTbd/Sm99tLPwXN/5/5/bb7/7/AEwA975r1X0lWKvucFHW0kTX09FSudM4vA0jY8jz2XlX6XzXpvpQudZSC3U9PVSxQVFM4SxtdgPGQNx1XoORI9F88dyslRbpzn1OqZUMB6Z3H/mb90nA1x/K3pHvVYTlskTgz+yHtA+wCX0bMitPDzrjUYBr61lOzzGcD7k/RP4Ot35K9JV7p8aYxEXxjH6LntcPxUDHv4qkpLBdLCKVjmVM73mYvILfaB5Y/Z+639624h4HJ8/7jFhTwtFV8M3a/Gqe2SmqHsEIYCHe0Oudve+y3N624i4HJ57/ANxikJb7hBB6UL5Q1Dg11bDEyMk8yGDb4kE/RYziCpudit7eFKuGL1WKYSxVAzmVuokEdOvywri88My8QccX6WGt9UfQxxTAhhJJ0AjBBGOS68Q1P8ovRrbrtWBprIpmt1gc/aLXfXAPxQdvShY66ukguNLCHUtJSnxnl4Bb7WeR3PNdKZjr/wCj60y2stlr7NIyQ05/TczOW/MYI7qJ6VbnW0tXR0cFVLFTVFMfFia7DX+0eY6qNw9Q1PCM1hukVYJYby9kUtPoIADuRzncgnb+KfQyHEF7n4gu0lfVRRwyua1hZHnA0jHXdVq1HpGo4aPjGqELQwTNZMQNhqcN8fPf5rLqUBKkShB2pad1VUxwtOC92M9u5W84gj/J1ppqKJpblrSR1aB7rf3/ABJVHwTRRz3R1RP/ADVO3UfM9vwWj41lDPA6+J7We4wsc7u6bYTUYkZyTz77rrFECcvOOy5td7S7tOXNLzjG4cOvYfVVXLdoohAxsZa4tJ3Hblz+SosYeOXPqrao5YVY8fnFpgzzcHAg7pFIc3U09wo5GCtGQQhCBQgISoEKOqEiBUiEIBSaRhcT9FGVlbGg4z+vhVy9LY+02KnDS0KxpqZjmZdvg8lHkDYZcEnAPRdY5AxxGTkHmdgua7dMkaa1MhbERpazAG6i3BzHSAMPu7ZUakqHiNxJOwxsoNTUv1Fzid+ar7W9Lu+R/lXhAE+1JTjAI8l5ovQLXVNfb6iFzshzc/6rBTs8KeRn6riPuujiv0w5Z9uaEIWrE1CEIBWtRejNZqSgbFoNM7UJNXPn0+aql1hpp6jPgQyS456Gk4+ijKS91aWz0ubhxNJWV9FWRwCKSlzsXZDs81OqeM2vhlNPQNiqZW6XSlwONsdsnHTKy7YZHSGNsby8c2hpz9ENgle5wbG9xb7wDScfFZ/Fh116W+TMxeizelKGohDJbFHIQzQHPlDsbY2y1eemGQR+IY3eH+tpOPqldDIxge+N7Wu5EtIBWvTPtoqri90nD9qtVLSeAKCRspk8TPiOGTnGNtySrGT0iP8A5UxXqnt7Yz4HgTROlz4jc5BBxsRt9Fi3xSRY8SNzM7jU0jK6Q0dTUM1QU8sjc4yyMuGfko6Gv4j4+jutnktlutraGGd+uZ2oEu3zyAA3PMqbbfSdHT2+kiuFoZV1VG3TFPrAPLGdwSDjY4WD9UqBP4Bgl8bn4eg6vpzTXwSxzeC+J7ZcgaC0h2/LZNG2ptXHtXQcR111np2TsrtpoA7SAB7uDvyG2/NP4l44bebbDbaC3soKKN4kLGkEuI5DAAAG5KzAt9YZHRiknMjRkt8J2QO+MIfQVcYBkpZ2hxDRqjcMnty5qRvqz0pQVsD45bDE5zoywPfKHFuRjq1RLH6RY7fZ6WhuNqZWmix6vJqALccuYOCO4WMFFVGUxCmmMgGSzw3ZA74wiKiqp2l0NNNI0HBLI3EZ7bBRqG2pp+PHi93K5VtuiqTWxCJsZcMQgcsEg5WQHJdhR1Je9nq82tgy9vhnLfjtsm+rzCIS+FJ4TjgP0HST8VIYhPlglp3Bs0T4yRkB7S0/dK6nmjaxz4ZGtf7hcwgO+HdBqOF3uit7yNhJKdR8mjYfUhS+M6gCsjgJ2jjA+BxuudoElHSU1PLC8HBlcwxnJAOeWM9lS3iWpqKt89RDKwSO2L2Fo+G4WGt1vLqIzX74BXUOwMZ8yuM9HWU0AmlpZo4jykdG4NPzwnUlLV1bXOpqaeYM94xxlwHxwp0jYlkyoLjl5K7TPLcggg8sFRxyV8YpnXSN2HgrnKzS8hKOY+KdUbuJ6g5V1EYjCE/ZwTEAhCEAhCEAhCECqdb341jzBCgLvTSaJx+ryKjKbicbqrqd4doeOZSmYkB3LPNRyRpIyuPjFns7lp6LDW2+9LyjqAMg7ghR6v2mk8iORXOiYZc6HEtxuOoVg2jdPDIDsQMDUqXqtJ3EK2z6fE330rP1btdZM7u8n7q+tkIbWuZIMjqs/N/PSf2j+K24/dY8nqOaEIWrE1CEIBbalrH2rhGhlpQ0PlmGrI55cc/gFilran+hVs/6zf7zljzTfjP5a8f2tamJsfHFK9g0ukp3FxHUjI/AJIqb1e/3ks2bNTCXbzzn7grpV/02oQP/AJZ/4uUqNzammmqm++2KWB5/suP+fmuPd1P9OjXd/wBs04f7vIzn/m8v+8qRTsN44UoWOOXU9SyM/DOPwIUd39Xsf/V/95XXgaoP/wAZTu3bhsn7j+5bZftuU+qzn7pPzFdxfU+PfHRg5bAwMHx5n8VseCrlPafRxda6m0mWnnc9ofktzhg3+q83rZzVVs855ySOd9SvR+CJqOn9Hd0luMDp6RlQ4yxt5uGGeY646rpxx8cZGGV3lai8GXWp4h49mu1aGCSKkeXeGCAAAGjmexS8YxaPSRaKhucVBpng98Px+4Ltwi6jkqOK7haqV8VMKUtp4ce03LScYyeoXTieJ8lXwRWSNLXv8GN7XDBBBYcH6lW+0Jd64gq7N6TmxUwYW1zKaCTXkkN1dN+e6Xi2/VbuOLXZCI/VWVVNODg6tWe+eW/ZVPGP9alv/t0395O4sP8AvZt//UpvxCgaqiJ/2qXQ5P8AwEXX+yqThu6T2b0e3evpdJmgrJC0PyRuWDcfNauCrt7+MaulipHNuTKZj5KnbDmHGG8/h06LLcMTUVPwDd5rnAaiiZWSGWJvNwyzHUdcdUS58GXaovj+KK+qDWzS07dXhggbMeP3KHOT/sos25x62z++9SeB5qSd/FctuhMNG+PMUTubG6X4HM/ios/9U9n/APFt/vvRCP6WSf5RUuSf+F6n9tyvr3QOreArLMzJfS+rPz2Bw0/iPoqD0sf0ipf/AAv/AL3LZ0T2z2izWyQgNrbadP8AaY1hH45+SfR9uzxj0jtJcSXUZHPljKzD+IKi/cWUlsuUcDqenryGANO+CQM5O/JaP1jPpIZCG7+o6tXzKw3F9ZQuvLG2ajkpayCd5mkA3kfkEEYJ6gn5qi8bW5Xlrrhf7Xc5KeOkFM3wGybF5cw55898fBV9Fc5LBwVw1LSiKOKonjbUveNg1xdqJPQ+fkmVvhcb8MvrGReDdrezEjSMdMkY7EZI7FQuD7jFW293Dl4iLqOpyIJHAgEnfSD3zuD3U7NdMvx3NSVHFtXNQyxSwyBjtcTgWl2kZOR5rO5Vjf7Q+xXqpt73axE72X4xqaRkH6FVq0Znt94Z7rpUOBc4tOcHPyTAwBwy4EdcJpdgnHunog5H2T5FKRn4oG4x9Eg54QIhKUiAQhCAQhCAS9EDuutPBJUSBsTC89ggkiX82AfeClUNJNWPLYoy49TjYKzoOH2sw+r9vP6A5Baehjja0M0tbEB0GFzZck9YurDjvvJTW2zTQTB2p7RjnpwCregiZ6zIyRoBOw7qZUXOlgZ4bHjT3yqiSvhim1ROyTzys97aa16QK6l9Svh/UeNQ2WLlOZnnu4rZ3GpNVUR1JIOjIOPh/BYonLie634nPykQhC2YkQhCAWyt3qt24apaM1ccMtPIHODiM7Enke4KxqFTPDyi+OXi3MlzpZ+NKd7J4zFDC5jpC4BudzjPzTbPdIWsvFPJNG389I+MucMODs8vp91iELP4JrW1/lu9tjbY6Wv4SiopqyKncXlx1OGRhxPIlc+HPVrbea+E1MbomxhrZHOADtx5rJoU/F7m/aPk9XXorved8St3Yaymj9GF7p5KiJs75HFsbngOdszkOZ5FYNC2ZPQuD7xHYeB7vWQ1EDa8ygxRvcC44DQPZzkjc/RWFyvcN94f4br6qqphWRXCJ8zGvDS0aiCdOcgbAry5CjRtvuLa2ln9JlBURVMMkDX0+ZGvBaMO33GyXiitpZvSjQ1MVTC+BslOTK14LRg778lgEKdG3slHdLe30l3GodXUwgdQxtbJ4zdJPs7A5ws7R1tK30Z3yndUwid9S8siLxqcNTOQ5lee7dkqjRtu/RpcaKnmulDWVDKc1sIbG95ABPtAjJ2z7WfkpvE76CzcJWqwRV8VXUx1DXuMZGzQScnBOPewvOEYU6NvV+ObTab86S4Nv1LHJS0zg2Fr2O8QjLgM6uucKFWXmmpDwTPFURP8BobNpkB0BzWNOR05nn2Xmwbk4AyT2Cnx2eoGDM3w8jOnbV9OnzVbqe0yW+nqbrlRj0lNm9bpzAKDHi+I3Rqyds55qtuNuttr4joL3+VY5g+ry9jMEMbuSdiVg3RNf7LhpPTUOalUr43R+rznS3O2B1VNtfF6ZPJb7TLerwblBO2viAjiY4E5DSABg75+yhWo0F74dsLTcoaeW2SNfLHI4Akt6bkc9t1hW2yWmnYY2tkYS32vj/oUk1okjijDjF+cOwznHzUbNNDeqa2cUcQXarF0jp4qWBvhuIaRMQ07DJG2R0Xnjn5G7Wn4K1mpfCnfGeTTzx3UWW1T41xNLm9uqvjlPtW436Qc9srrDTT1AJghkkxz0tJU62OpGFzKqi8Z7SS7JIICtpLzBT+EaaJ0Gg7MxgYKZZ2dSGOEs3azbqeZmz4JBnoWEJj4y04eC0/tDC1TeKJHZbKcg8j1H0XYQPvtP4NWG4bvFMzBc3/EKvyWe4t8cvqsZuEZUuut09vl0TMIB9145OUXC1l2ys17IkSpQ0u5DKINSj4KZTWuqqXAMjO/Lbmril4bGoeM7U7q0ZKrc5F5hlVXQW19W4OkJbFnoOfwWso6SnoYw2GMeIft8V1ZTQ0LmN8J7gwE4aOZ6fJNbX1AYRT0moE5L3N5LmzyuTowxmKygo3FvizyNY08+n1Ue4XCnDDHDv3A2Kq5pql2qSeZrW590HJyqyaqibv7z+hKiRa0k0rslzMgdMlRJKiYkcjnYYTXyuld7JynQlkBLnHLwNvJayaZW7dzJJBb5vEzqznfvjCpAzIJHRWVwq5KmlAI2DunZVgyAtMJ0y5L2RCRCuoEIQgEIQgEqRKgEIQgEqRCBUiVIgVCEIgqEIQKEqRSrfF49bCw8i4Z+CW6TO2itVobbWMqKzAqJG6mM6sB5Z806prxSTuLoh7TcNLh1US73N0la8xkaRsCPJVlXUuqWhzjkhc/jbd10+Uxx1HKeZz3HJzulirNWzzhw21d1wLsri4LXUZXKruG4SxnGolvYnYK0hqKaduqUnWCDpzsPgskyRzdsqdTVmlwa8loPZVuKZk03qrYGyOedbZCG6j+iQP8hcaeGaePxYWCSPl5b8lHbWPbSs8STXG8FrR1HbPffqptFcpKejgNTCHROBaCAN8d+/8ABZ1rKZXn8nMErtJmeMDSNs53yeqRl6ZVMDauNrjjBOOS7T3e2n82+ja5sYw3DjjfdcW3S0R4ey2RCRuwLiT9iq6/hfevtxpLDT1Vz1UznSxaS7bbSem/Iq9pZqemDmuiw8ZIa3ln4qLDxJCS0O0RMA91gH+igV76u4u8UlhiHu6XA/ZO77R1PS4uVPSVNNiQiWOQZETfac0/uVD/ACZp3FhZHUkOO4yMD5p9FNUUkmp427Fuy6VNx8ckiXw9unNTNz0iyX26fkG2Rj2wSRvzO6YDbaY4jpsDu47qvFy8BvtHxnknSCOSjy1D6l5c8jUeg5BTq32jeM9LeW6xRzaKQBrBu5w5/DPZK29zMIc8kk8mnr5qjbIyPIZhx7pjp9JLnOy47ZJU+KPNpBfCCXkNLzv5AdlCqr3LMXHXjPQbBULqk/o/UrkZSTuVM40XkTpqtztgfuopJJy4riZschuukEetwMnLsr60z3uplLTz1ZDKaMkHm47D6qwbw1XaPEd4YYOo3T6W5CjA8PAAG23JWFPeX1YbCdw44JysrlW0xgpLTSSUpp3hsshydeNLx8O/wWUutA631RjJ1M/RcOq3/qRjOmCRpkLCQWnB1BZa+vbVMe/GM4e3yU4ZWVXPGWM0hCF0OcIQhAIQhAIQhAJUiVAIQhAqEiECoSJUQVCTdLkoFVjZ2ONS945NYcnsq3JVvanaKScnbIzn4f6qufpfD2hyOJkdk53XMu2ISvdlxK5kqEmkppKCkAVlSjmug9pMDU7UGolIZK9rQ0HZpyM9FeUskFZQeHUF7WB+GSA+6/rkLNiRSaGs8KV0bziKQjV5YVLjtfHLSTPRyuqH6ZmEg4y7bKb+TpxuZo8dcHKbU072O8SKTxWvJ8iPiuJZUDc7fNR3+U9fh3bQlzw0S6f2invdNSHJdqYOueaiB02dnk/NOMpHNgfJ3JyE0jcd3yvly/xXeH31aQubpWaMNLpD3OzR/iuDnNfu4Eu6gbBcny4OO3QcgpmKLkkB7QRgan9zyCJpnO2fJkdhyUPxHd03J7q3ijySDL7OAuZdnqmc0cgp0rs7KlwRx6WucMk77qEOSlxn8wzHRRknFylj0ynbYnIXRj9PxSPkyMHdcx36Il3c9zh5LrTVLmFozgBRw7DMJFXSZdNHBWP1tfHIQ5u4JKiXTPqYlA2eSodJI4vA5Bd7hKW0xa3lkOB5F';

function checkIn() {
  community.addCheckIn(
    challenge.memberName.value || 'Anonymous',
    challenge.currentDay.value,
    challenge.todaysEntry.value.scheduledMiss ? 'scheduled' : 'complete',
  );
}
</script>

<template>
  <main class="app-shell">
    <header class="topbar">
      <div>
        <span class="brand-mark">77</span>
        <span class="brand-name">Dominion</span>
      </div>
      <button class="theme-toggle" @click="theme.toggleTheme">
        {{ theme.label.value }} Theme
      </button>
    </header>

    <HeroSection />

    <section class="card" aria-label="77 Days. No excuses. Only faithfulness.">
      <img :src="dominionPoster" alt="77 Days. No excuses. Only faithfulness. Dominion Challenge." style="display: block; width: 100%; height: auto; border-radius: 16px;" />
    </section>

    <details class="card challenge-details">
      <summary>
        <span>
          <span class="eyebrow">About the Challenge</span>
          <strong>What is the 77-Day Dominion Challenge?</strong>
        </span>
        <span class="summary-icon">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M6 9L12 15L18 9"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </span>
      </summary>
      <div class="details-body">
        <p>
          The 77-Day Dominion Challenge is a focused season of spiritual, mental, and physical discipline. It is designed to help you honor God, steward your body, and train yourself to keep commitments even when motivation fades.
        </p>
        <p>
          Each day is built around seven standards: reading 5–8 chapters of the Bible, praying morning and evening, listening only to worship music, completing two intentional workouts, and taking an intentional walk during the day.
        </p>
        <p>
          Workouts do not have a required length. Some days may be intense. Other days may be recovery-focused with stretching, mobility, walking, or light movement. The goal is consistency, not recklessness.
        </p>
        <p>
          Scheduled miss days are allowed when planned ahead. Unplanned misses because of laziness, busyness, tiredness, or poor planning are not the spirit of the challenge.
        </p>
        <ul>
          <li><strong>Spirit:</strong> Bible reading, morning prayer, evening prayer.</li>
          <li><strong>Mind:</strong> Worship music only.</li>
          <li><strong>Body:</strong> Workout #1, intentional walk, workout #2.</li>
          <li><strong>Accountability:</strong> Check in honestly and stay connected with others doing the challenge.</li>
        </ul>
      </div>
    </details>

    <section class="dashboard card">
      <label>
        Your name
        <input v-model="challenge.memberName.value" placeholder="Tim" />
      </label>
      <label>
        Challenge start date
        <input v-model="challenge.startDate.value" type="date" />
      </label>
      <div class="rings">
        <ProgressRing :value="challenge.progressPercent.value" label="Challenge" :sublabel="`Day ${challenge.currentDay.value} of 77`" />
        <ProgressRing :value="challenge.todayPercent.value" label="Today" :sublabel="`${challenge.completedCount.value} of 7 done`" />
      </div>
      <button class="primary" :disabled="!challenge.isComplete.value && !challenge.todaysEntry.value.scheduledMiss" @click="checkIn">
        Post Check-In
      </button>
    </section>

    <DailyChecklist
      :standards="challenge.standards"
      :entry="challenge.todaysEntry.value"
      @toggle="challenge.toggleStandard"
      @scheduled="challenge.toggleScheduledMiss"
    />

    <section class="card rules">
      <p class="eyebrow">Rules</p>
      <ul>
        <li>Commit to 77 days of intentional discipline.</li>
        <li>Scheduled miss days are allowed only when planned ahead.</li>
        <li>No missing because of laziness, tiredness, busyness, or poor planning.</li>
        <li>When life changes, adapt the standard instead of abandoning it.</li>
      </ul>
    </section>

    <CommunityFeed :feed="community.feed.value" :completed-today="community.completedToday.value" />
  </main>
</template>
