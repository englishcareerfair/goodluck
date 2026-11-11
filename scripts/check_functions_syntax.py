import sys

def check_js(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    stack = []
    line = 1
    col = 1
    in_string = None
    in_comment = False
    in_regex = False
    escaped = False

    i = 0
    n = len(content)
    while i < n:
        c = content[i]
        
        if c == '\n':
            line += 1
            col = 1
            i += 1
            continue

        if in_comment:
            if in_comment == 'single' and c == '\n':
                in_comment = False
            elif in_comment == 'multi' and content[i:i+2] == '*/':
                in_comment = False
                i += 2
                col += 2
                continue
            i += 1
            col += 1
            continue

        if in_string:
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == in_string:
                in_string = None
            i += 1
            col += 1
            continue

        # Not in string or comment
        if content[i:i+2] == '//':
            in_comment = 'single'
            i += 2
            col += 2
            continue
        if content[i:i+2] == '/*':
            in_comment = 'multi'
            i += 2
            col += 2
            continue

        if c in ('"', "'", '`'):
            in_string = c
            escaped = False
            i += 1
            col += 1
            continue

        if c in '{[(':
            stack.append((c, line, col))
        elif c in '}])':
            if not stack:
                print(f"EXTRA CLOSING: '{c}' at line {line}:{col}")
                return False
            open_c, o_line, o_col = stack.pop()
            expected = {'{': '}', '[': ']', '(': ')'}[open_c]
            if c != expected:
                print(f"MISMATCH: Expected '{expected}' for '{open_c}' from line {o_line}:{o_col}, but found '{c}' at line {line}:{col}")
                return False

        i += 1
        col += 1

    if stack:
        print(f"UNCLOSED: {len(stack)} items left on stack. First unclosed: '{stack[0][0]}' from line {stack[0][1]}:{stack[0][2]}")
        return False

    print(f"SUCCESS: {filepath} syntax is completely balanced!")
    return True

check_js('functions/api/[[path]].js')
check_js('functions/_middleware.js')
